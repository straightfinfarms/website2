// =====================================================================
// GOOGLE PLACES REVIEWS — server-side proxy with caching
// =====================================================================
// Exposes getGoogleReviews() which returns the place rating + 4-5 star
// reviews from Google Places. Result is cached for 12h to stay well
// inside the Places API free tier.
// Wired into doGet via: ?action=reviews
// =====================================================================

function getGoogleReviews() {
  const cache = CacheService.getScriptCache();
  const CACHE_KEY = 'google_reviews_v1';
  const cached = cache.get(CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('PLACES_API_KEY');
  if (!apiKey) {
    return { error: 'PLACES_API_KEY not set in Script Properties' };
  }

  // Look up Place ID once, then cache forever (Place IDs are stable).
  let placeId = props.getProperty('PLACES_PLACE_ID');
  if (!placeId) {
    placeId = findStraightFinFarmsPlaceId_(apiKey);
    if (!placeId) return { error: 'Could not resolve Place ID for Straight Fin Farms' };
    props.setProperty('PLACES_PLACE_ID', placeId);
  }

  // Fetch place details with reviews
  const url = 'https://maps.googleapis.com/maps/api/place/details/json'
    + '?place_id=' + encodeURIComponent(placeId)
    + '&fields=name,rating,user_ratings_total,reviews,url'
    + '&key=' + encodeURIComponent(apiKey);

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());

  if (data.status !== 'OK') {
    return { error: 'Places API: ' + data.status, message: data.error_message || '' };
  }

  const r = data.result || {};
  const filtered = (r.reviews || [])
    .filter(rv => rv.rating >= 4)
    .map(rv => ({
      author: rv.author_name,
      photo: rv.profile_photo_url,
      rating: rv.rating,
      text: rv.text,
      relativeTime: rv.relative_time_description,
      time: rv.time,
    }));

  const out = {
    name: r.name,
    rating: r.rating,
    totalReviews: r.user_ratings_total,
    googleUrl: r.url,
    reviews: filtered,
    fetchedAt: new Date().toISOString(),
  };

  cache.put(CACHE_KEY, JSON.stringify(out), 12 * 60 * 60); // 12h
  return out;
}

function findStraightFinFarmsPlaceId_(apiKey) {
  const query = 'Straight Fin Farms 1091 County Rd 24 Dunsford ON';
  const url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json'
    + '?input=' + encodeURIComponent(query)
    + '&inputtype=textquery'
    + '&fields=place_id,name,formatted_address'
    + '&key=' + encodeURIComponent(apiKey);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());
  if (data.status !== 'OK' || !data.candidates || !data.candidates.length) return null;
  return data.candidates[0].place_id;
}

// Manual test helper — run this from the editor "Run" dropdown to verify.
function testGoogleReviews() {
  const result = getGoogleReviews();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// Reset the cached reviews + Place ID (run if you need to force a refresh).
function resetGoogleReviewsCache() {
  CacheService.getScriptCache().remove('google_reviews_v1');
  PropertiesService.getScriptProperties().deleteProperty('PLACES_PLACE_ID');
  Logger.log('Reviews cache cleared.');
}

// Public web app entry — call from doGet when action === 'reviews'.
function serveReviewsJson_() {
  return ContentService.createTextOutput(JSON.stringify(getGoogleReviews()))
    .setMimeType(ContentService.MimeType.JSON);
}
