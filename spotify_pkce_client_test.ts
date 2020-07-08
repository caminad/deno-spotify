// Copyright 2020 David Jones. MIT license.
import SpotifyPKCEClient from "./spotify_pkce_client.ts";

/**
 * Example client using a test Spotify app ID. The callback URL must be explicitly allowed in the [Spotify dashboard][1]. Requires a web browser to complete the authentication flow.
 *
 * [1]: https://developer.spotify.com/dashboard/applications/
 */
const client = new SpotifyPKCEClient({
  id: `3d83a0eec08147f195388e5526781b59`,
  callback: `http://localhost:49918/callback`,
});

const accessToken = await client.requestAccessToken();

console.log(`Access token is`, accessToken.isValid() ? `valid` : `not valid`);

console.log(`Current user:`, await accessToken.fetch(`me`));

const refreshedToken = await accessToken.refresh();

console.log(
  `Current user with refreshed token:`,
  await refreshedToken.fetch(`me`)
);

const scopedToken = await client.requestAccessToken([
  `user-read-email`,
  `user-read-private`,
]);

console.log(`Current user with scoped token:`, await scopedToken.fetch(`me`));
