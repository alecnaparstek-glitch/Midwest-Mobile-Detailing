export const WINTER_DISCOUNT = 20;

export const BOOKING_START_TIMES = Object.freeze({
  0: Object.freeze(["08:00", "11:00", "14:00"]),
  6: Object.freeze(["14:00"])
});

const weekday = date => new Date(date + 'T12:00:00Z').getUTCDay();

export function bookingDayClosed(date) {
  return [1, 2, 3, 4, 5].includes(weekday(date));
}

export function winterOfferEligible(date) {
  return date >= '2026-11-09' && date <= '2027-02-28' &&
    [1, 2, 3].includes(weekday(date)) && !bookingDayClosed(date);
}
