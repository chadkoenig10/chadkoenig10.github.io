/* Caddie — course-search edge function (Deno).
 *
 * Proxies the Google Places API (New) Text Search so the API key never ships
 * in the public web app. Deploy via the Supabase dashboard:
 *   1. Edge Functions -> New Function, name it exactly `course-search`
 *   2. Paste this file as index.ts
 *   3. Add a secret named GOOGLE_PLACES_API_KEY (Project Settings -> Edge Functions -> Secrets)
 *   4. Leave "Verify JWT" ON — the web client calls this with the anon key
 *      via supabase.functions.invoke(), which sends it as the Authorization header.
 *
 * POST JSON body: { mode: "search" | "geocode", query: string, lat?: number, lng?: number }
 *   search : textQuery biased to a circle around (lat,lng) when provided,
 *            filtered to golf_course, up to 10 results.
 *   geocode: textQuery for the trip destination (e.g. "Lake of the Ozarks, MO"),
 *            single best match, used to bias later searches.
 * Response: { places: [{ name, address, lat, lng, rating, ratings }] }
 */

var CORS = {
  "Access-Control-Allow-Origin": "https://chadkoenig10.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({}, CORS, { "Content-Type": "application/json" }),
  });
}

Deno.serve(async function (req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  var apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!apiKey) return json({ error: "Course search is not configured." }, 500);

  var body;
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Request body must be JSON." }, 400);
  }
  var mode = body && body.mode;
  var query = body && typeof body.query === "string" ? body.query.trim() : "";
  var lat = body && typeof body.lat === "number" ? body.lat : null;
  var lng = body && typeof body.lng === "number" ? body.lng : null;

  if (mode !== "search" && mode !== "geocode") return json({ error: "Invalid mode." }, 400);
  if (!query) return json({ error: "Missing search query." }, 400);

  var isSearch = mode === "search";
  var payload = {
    textQuery: query,
    maxResultCount: isSearch ? 10 : 1,
  };
  if (isSearch) payload.includedType = "golf_course";
  if (isSearch && lat !== null && lng !== null) {
    payload.locationBias = {
      circle: { center: { latitude: lat, longitude: lng }, radius: 80000 },
    };
  }
  var fieldMask = isSearch
    ? "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount"
    : "places.displayName,places.location";

  var r;
  try {
    r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(payload),
    });
  } catch (_e) {
    return json({ error: "Course search isn't available right now." }, 502);
  }
  if (!r.ok) return json({ error: "Course search isn't available right now." }, 502);

  var data;
  try {
    data = await r.json();
  } catch (_e) {
    return json({ error: "Course search isn't available right now." }, 502);
  }

  var places = (data.places || [])
    .map(function (p) {
      return {
        name: p.displayName && p.displayName.text ? p.displayName.text : "",
        address: p.formattedAddress || "",
        lat: p.location && typeof p.location.latitude === "number" ? p.location.latitude : null,
        lng: p.location && typeof p.location.longitude === "number" ? p.location.longitude : null,
        rating: typeof p.rating === "number" ? p.rating : null,
        ratings: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      };
    })
    .filter(function (p) { return !!p.name; });

  return json({ places: places }, 200);
});
