// Current position as a promise. Geo-tagged records take their position
// from the device at the moment of recording -- never from a typed value.
export function getPosition({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return reject(Object.assign(new Error("no-geolocation"), { code: "none" }));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: Number(pos.coords.latitude.toFixed(6)),
        longitude: Number(pos.coords.longitude.toFixed(6)),
        accuracy: pos.coords.accuracy,
      }),
      (err) => reject(Object.assign(new Error(err.message), { code: err.code === 1 ? "refused" : "failed" })),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}

export const isOnline = () => typeof navigator === "undefined" || navigator.onLine;

export function formatDistance(m) {
  if (m == null) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
