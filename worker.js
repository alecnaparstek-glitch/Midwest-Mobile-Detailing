const LOCATION = "LR9S8A5TFKB2S";
const ZONE = "America/Chicago";
const PACKS = { interior: "Midwest Cabin Refresh", exterior: "Midwest Fresh Finish", complete: "Midwest Full Reset" };
const ADDONS = { ceramic: { name: "Ceramic Wax", packs: ["exterior","complete"] }, stain: { name: "Heavy Stain Removal", packs: ["interior","complete"] } };
const reply = (value, status=200) => new Response(JSON.stringify(value), {status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
class BookingError extends Error { constructor(message,status=503,code="SETUP_REQUIRED"){super(message);this.status=status;this.code=code;} }
async function square(env,path,body) {
  if(!env.SQUARE_ACCESS_TOKEN) throw new BookingError("Online booking is temporarily unavailable.");
  const response=await fetch("https://connect.squareup.com/v2"+path,{
    method:body===undefined?"GET":"POST",
    headers:{"Authorization":"Bearer "+env.SQUARE_ACCESS_TOKEN,"Square-Version":"2026-09-16","Content-Type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)
  });
  const data=await response.json();
  if(!response.ok||data.errors?.length){
    const code=data.errors?.[0]?.code||"SQUARE_ERROR";
    if(code==="UNAUTHORIZED"||code==="ACCESS_TOKEN_EXPIRED")throw new BookingError("Square credentials need attention.",503,"CREDENTIALS");
    if(code==="FORBIDDEN"||code==="SUBSCRIPTION_REQUIRED")throw new BookingError("Square booking API access needs attention.",503,"API_ACCESS");
    throw new BookingError("Square could not complete this request. Please try again or contact us.",response.status===429?429:503,code);
  }
  return data;
}
const normal=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
async function catalog(env){
  const items=[];let cursor;
  do{
    const r=await square(env,"/catalog/search-catalog-items",{product_types:["APPOINTMENTS_SERVICE"],limit:100,...(cursor?{cursor}:{})});
    items.push(...(r.items||[]));cursor=r.cursor;
    if(items.length>1000)throw new BookingError("Service configuration needs attention.");
  }while(cursor);
  return items.flatMap(item=>(item.item_data?.variations||[]).filter(v=>!v.is_deleted&&v.item_variation_data?.available_for_booking&&
    (v.present_at_all_locations!==false||v.present_at_location_ids?.includes(LOCATION))&&!v.absent_at_location_ids?.includes(LOCATION)).map(v=>({
      id:v.id,version:v.version,item:item.item_data.name,name:v.item_variation_data.name,
      duration:Math.round(Number(v.item_variation_data.service_duration)/60000)
    }))).filter(v=>v.duration>0&&v.version);
}
function selectService(services,name,tier,override){
  if(override){const v=services.find(v=>v.id===override);if(v)return v;throw new BookingError("A linked Square service is not bookable.");}
  const candidates=services.filter(v=>normal(v.item)===normal(name));
  if(candidates.length===1)return candidates[0];
  const labels=[["sedan","coupe","car"],["suv","truck"],["oversized","large","van"]][tier]||[];
  const matched=candidates.filter(v=>labels.some(label=>normal(v.name).includes(label)));
  if(matched.length===1)return matched[0];
  throw new BookingError(name+" is not configured for online booking.",503,"SERVICE_NOT_LINKED");
}
function selection(input){
  if(!Object.hasOwn(PACKS,input.pack)||!Number.isInteger(input.size)||input.size<0||input.size>2)throw new BookingError("Select a package and vehicle.",400,"INVALID_INPUT");
  if(!Array.isArray(input.addOns)||input.addOns.length>2||new Set(input.addOns).size!==input.addOns.length||input.addOns.some(id=>!ADDONS[id]?.packs.includes(input.pack)))throw new BookingError("Invalid add-on selection.",400,"INVALID_INPUT");
  return {pack:input.pack,size:input.size,addOns:input.addOns};
}
async function segmentsFor(env,input){
  const choice=selection(input),services=await catalog(env);
  let mapping={};if(env.SQUARE_SERVICE_MAP){try{mapping=JSON.parse(env.SQUARE_SERVICE_MAP)}catch{throw new BookingError("Service mapping needs attention.")}}
  const primary=selectService(services,PACKS[choice.pack],choice.size,mapping[choice.pack]?.[choice.size]||mapping[choice.pack]?.default);
  return [primary,...choice.addOns.map(id=>selectService(services,ADDONS[id].name,choice.size,mapping[id]?.default))];
}
function dayOf(iso){return new Intl.DateTimeFormat("en-CA",{timeZone:ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(iso));}
function dateRange(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+"T12:00:00Z")))throw new BookingError("Choose a valid day.",400,"INVALID_INPUT");
  // Search a wider UTC range, then filter by the business timezone (including DST).
  const time=Date.parse(day+"T00:00:00Z");
  if(time<Date.now()-86400000||time>Date.now()+90*86400000)throw new BookingError("Choose a day within the next 90 days.",400,"INVALID_INPUT");
  return {start_at:new Date(Math.max(Date.now()+60000,time)).toISOString(),end_at:new Date(time+2*86400000).toISOString()};
}
async function availability(env,input){
  const profile=(await square(env,"/bookings/business-booking-profile")).business_booking_profile;
  if(!profile?.booking_enabled||!profile?.support_seller_level_writes)throw new BookingError("Online booking is temporarily unavailable. Please contact us to schedule.",503,"API_ACCESS");
  const segments=await segmentsFor(env,input),range=dateRange(input.date);
  const r=await square(env,"/bookings/availability/search",{query:{filter:{location_id:LOCATION,start_at_range:range,segment_filters:segments.map(s=>({service_variation_id:s.id}))}}});
  return (r.availabilities||[]).filter(a=>dayOf(a.start_at)===input.date&&Date.parse(a.start_at)>Date.now());
}
function safeText(value,max){return typeof value==="string"?value.trim().slice(0,max):"";}
async function sign(env,data){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.SQUARE_ACCESS_TOKEN),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
  return {key,bytes:new TextEncoder().encode(JSON.stringify(data))};
}
async function slotToken(env,payload){
  const {key,bytes}=await sign(env,payload);
  const signature=new Uint8Array(await crypto.subtle.sign("HMAC",key,bytes));
  return btoa(JSON.stringify(payload))+"."+btoa(String.fromCharCode(...signature));
}
async function readToken(env,token){
  try{
    const [body,sig]=token.split("."),payload=JSON.parse(atob(body));
    const {key,bytes}=await sign(env,payload);
    if(!await crypto.subtle.verify("HMAC",key,Uint8Array.from(atob(sig),c=>c.charCodeAt(0)),bytes)||payload.expires<Date.now())throw Error();
    selection(payload);return payload;
  }catch{throw new BookingError("Your time selection expired. Please choose a time again.",409,"SLOT_EXPIRED")}
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(request);
    try{
      if(url.pathname==="/api/booking/status"&&request.method==="GET"){
        if(!env.SQUARE_ACCESS_TOKEN)return reply({backend:"ready",squareConnected:false,bookingEnabled:false,issue:"TOKEN_MISSING"});
        const [services,profile]=await Promise.all([catalog(env),square(env,"/bookings/business-booking-profile")]);
        const linked={};for(const [id,name]of Object.entries(PACKS)){try{selectService(services,name,0);linked[id]=true}catch{linked[id]=false}}
        return reply({backend:"ready",squareConnected:true,bookingEnabled:Boolean(env.BOOKING_COORDINATOR)&&profile.business_booking_profile?.booking_enabled===true&&profile.business_booking_profile?.support_seller_level_writes===true&&Object.values(linked).every(Boolean),
          sellerBookingWrites:profile.business_booking_profile?.support_seller_level_writes===true,packages:linked,bookableServiceNames:[...new Set(services.map(v=>v.item))]});
      }
      if(request.method!=="POST")return reply({error:"Method not allowed"},405);
      if(request.headers.get("Origin")!==url.origin||!request.headers.get("Content-Type")?.startsWith("application/json"))return reply({error:"Invalid request"},403);
      if(Number(request.headers.get("Content-Length")||0)>16000)return reply({error:"Request too large"},413);
      const raw=await request.text();if(raw.length>16000)return reply({error:"Request too large"},413);
      let input;try{input=JSON.parse(raw)}catch{return reply({error:"Invalid request"},400)}
      if(url.pathname==="/api/booking/availability"){
        const choice=selection(input),slots=await availability(env,{...choice,date:input.date}),unique=new Map();
        for(const a of slots){
          if(unique.has(a.start_at))continue;
          const token=await slotToken(env,{...choice,date:input.date,start:a.start_at,team:a.appointment_segments[0].team_member_id,expires:Date.now()+15*60000});
          unique.set(a.start_at,{start:a.start_at,token,duration:a.appointment_segments.reduce((n,s)=>n+s.duration_minutes,0)});
        }
        return reply({slots:[...unique.values()],timezone:ZONE});
      }
      if(url.pathname==="/api/booking/create"){
        if(input.website)return reply({error:"Invalid request"},400);
        if(!/^[a-zA-Z0-9-]{20,64}$/.test(input.requestId||""))throw new BookingError("Invalid booking request.",400,"INVALID_INPUT");
        const name=safeText(input.name,100),address=safeText(input.address,300),vehicle=safeText(input.vehicle,120),phone=String(input.phone||"").replace(/\D/g,"");
        if(!name||address.length<8||!vehicle||!(/^1?\d{10}$/.test(phone)))throw new BookingError("Enter your name, a US phone number, vehicle, and full service address.",400,"INVALID_INPUT");
        const slot=await readToken(env,input.token||"");
        if(!env.BOOKING_COORDINATOR)throw new BookingError("Online booking is temporarily unavailable.");
        const id=env.BOOKING_COORDINATOR.idFromName(LOCATION+":"+slot.date);
        return env.BOOKING_COORDINATOR.get(id).fetch("https://booking.internal/create",{method:"POST",body:JSON.stringify({slot,name,address,vehicle,phone:"+"+(phone.length===10?"1":"")+phone,pet:input.pet===true,requestId:input.requestId,ip:request.headers.get("CF-Connecting-IP")||"unknown"})});
      }
      return reply({error:"Not found"},404);
    }catch(e){return reply({error:e instanceof BookingError?e.message:"Booking is temporarily unavailable. Please try again.",code:e.code||"UNAVAILABLE"},e.status||503)}
  }
};
export class BookingCoordinator {
  constructor(state,env){this.state=state;this.env=env;this.queue=Promise.resolve();}
  async fetch(request){
    const previous=this.queue;let release;this.queue=new Promise(resolve=>{release=resolve});await previous;
    try{return await this.create(await request.json())}catch(e){return reply({error:e instanceof BookingError?e.message:"Unable to complete booking. Please retry with the same details.",code:e.code||"UNAVAILABLE"},e.status||503)}finally{release()}
  }
  async create(input){
    const key="request:"+input.requestId,hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({...input,ip:undefined,slot:{...input.slot,expires:undefined}}))))).map(x=>x.toString(16).padStart(2,"0")).join("");
    const saved=await this.state.storage.get(key);
    if(saved){if(saved.hash!==hash)return reply({error:"This request has changed. Please choose a time again."},409);return reply(saved.result)}
    const rateKey="rate:"+input.ip,rate=await this.state.storage.get(rateKey)||0;
    if(rate>=10)return reply({error:"Too many attempts. Please contact us to book."},429);
    await this.state.storage.put(rateKey,rate+1);
    // Recover an uncertain previous submission before availability revalidation.
    const attempt=await this.state.storage.get("attempt:"+input.requestId);
    if(attempt){
      if(attempt.hash!==hash)return reply({error:"This request has changed. Please choose a time again."},409);
      return this.finish(input,key,hash,attempt.payload);
    }
    const slots=await availability(this.env,input.slot);
    const slot=slots.find(a=>a.start_at===input.slot.start&&a.appointment_segments[0].team_member_id===input.slot.team);
    if(!slot)return reply({error:"That time is no longer available. Please choose another.",code:"SLOT_TAKEN"},409);
    const customer=await square(this.env,"/customers",{idempotency_key:input.requestId,given_name:input.name,phone_number:input.phone});
    const extras=input.slot.addOns.map(id=>ADDONS[id].name);
    const note=["Website booking",PACKS[input.slot.pack],"Vehicle: "+input.vehicle,"Service address: "+input.address,
      extras.length?"Add-ons: "+extras.join(", "):"",input.pet?"Heavy pet hair removal: price after inspection":"",
      "Arrival window: first 30 minutes of appointment. Water and electricity access required."].filter(Boolean).join("\n");
    const payload={idempotency_key:input.requestId,booking:{location_id:LOCATION,start_at:slot.start_at,customer_id:customer.customer.id,
      customer_note:note,appointment_segments:slot.appointment_segments.map(s=>({team_member_id:s.team_member_id,service_variation_id:s.service_variation_id,service_variation_version:s.service_variation_version,duration_minutes:s.duration_minutes}))}};
    await this.state.storage.put("attempt:"+input.requestId,{hash,payload});
    await this.state.storage.setAlarm(Date.now()+7*86400000);
    return this.finish(input,key,hash,payload);
  }
  async finish(input,key,hash,payload){
    const r=await square(this.env,"/bookings",payload),b=r.booking;
    if(!b?.id||!["ACCEPTED","PENDING"].includes(b.status))throw new BookingError("Square did not confirm the booking. Please contact us.",503,"BOOKING_NOT_CONFIRMED");
    const result={id:b.id,status:b.status,start:b.start_at};
    await this.state.storage.put(key,{hash,result});
    return reply(result);
  }
  async alarm(){await this.state.storage.deleteAll();}
}
