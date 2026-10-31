const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/booking/status") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json({
        backend: "ready",
        squareTokenConfigured: Boolean(env.SQUARE_ACCESS_TOKEN),
        bookingEnabled: false
      });
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Online booking is not connected yet. No appointment has been created." }, 503);
    }
    return env.ASSETS.fetch(request);
  }
};
