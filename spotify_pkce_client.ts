// Copyright 2020 David Jones. MIT license.
import * as base64url from "https://deno.land/std@0.60.0/encoding/base64url.ts";
import { createHash } from "https://deno.land/std@0.60.0/hash/mod.ts";
import { serve } from "https://deno.land/std@0.60.0/http/server.ts";

/**
 * Proof Key for Code Exchange (PKCE) client for the Spotify API.
 */
export default class SpotifyPKCEClient {
  readonly id: string;
  readonly #callback: URL;

  /**
   * The `callback` parameter here must match one of the redirect_uri values you have registered in the Developer Dashboad. The user will be redirected to this URI after they grant or deny authorization to your app.
   *
   * Use a fixed port in the [IANA Dynamic and/or Private Ports range (49152-65535)][1] as the `callback_uri` must exactly match the safelisted value in the [Spotify applications dashboard][2]. For example:
   *
   * ```js
   * import("https://deno.land/x/random/Random.js")
   *   .then((mod) => new mod.default().int(49152, 65535))
   *   .then((port) => console.log(`http://localhost:${port}/callback`));
   * ```
   *
   * [1]: https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml
   * [2]: https://developer.spotify.com/dashboard/applications/
   */
  constructor(params: { id: string; callback: URL | string }) {
    this.id = params.id;
    this.#callback = new URL(params.callback);
  }

  /**
   * Resolves to an `AccessToken` after the user grants the permissions in a browser window.
   */
  async requestAccessToken(scopes?: string[]) {
    /**
     * [PKCE Authorization Step 1. Create the code verifier and challenge][1]
     *
     * > Before each authentication request your app should generate a code verifier and a code challenge. The code verifier is a cryptographically random string between 43 and 128 characters in length. It can contain letters, digits, underscores, periods, hyphens, or tildes.
     *
     * > In order to generate the code challenge, your app should hash the code verifier using the SHA256 algorithm. Then, base64url encode the hash that you generated.
     *
     * [1]: https://developer.spotify.com/documentation/general/guides/authorization-guide/#1-create-the-code-verifier-and-challenge
     */
    const codeVerifier = base64url.encode(
      crypto.getRandomValues(new Uint8Array(32))
    );

    /**
     * [PKCE Authorization Step 2. Construct the authorization URI][1]
     *
     * > The authorization URI is a Spotify endpoint that displays a permissions dialog to the user.
     *
     * [1]: https://developer.spotify.com/documentation/general/guides/authorization-guide/#2-construct-the-authorization-uri
     */
    const authURL = new URL(
      `https://accounts.spotify.com/authorize?${new URLSearchParams({
        client_id: this.id,
        response_type: `code`,
        redirect_uri: this.#callback.href,
        code_challenge_method: `S256`,
        code_challenge: base64url.encode(
          createHash("sha256").update(codeVerifier).digest()
        ),
        state: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
        ...(scopes && { scope: scopes.join(` `) }),
      })}`
    );

    /**
     * [PKCE Authorization Step 3. Your app redirects the user to the authorization URI][1]
     *
     * > When the user has been redirected to the authorization URI they will see a permissions dialog where they can agree to give your app access to their Spotify resources. After they accept or decline, the user will be redirected onwards to the URI that your app provided in the `redirect_uri` query parameter.
     *
     * [1]: https://developer.spotify.com/documentation/general/guides/authorization-guide/#3-your-app-redirects-the-user-to-the-authorization-uri
     */
    const server = serve(this.#callback.host);

    console.log(`Continue authentication at`, this.#callback.origin);

    let code = null;

    for await (const req of server) {
      const { searchParams } = new URL(req.url, this.#callback);

      // Handle unexpected requests.
      if (req.method !== `GET`) {
        await req.respond({
          status: 405,
          headers: new Headers({
            "content-type": `text/plain; charset=utf-8`,
            allow: `GET`,
          }),
          body: `Method Not Allowed\r\n`,
        });
        continue;
      }

      // Handle errors from Spotify.
      if (searchParams.has("error")) {
        await req.respond({
          status: 400,
          headers: new Headers({
            "content-type": `text/plain; charset=utf-8`,
          }),
          body: `Error(${searchParams.get("error")}): Authorization Failed\r\n`,
        });
        continue;
      }

      // Handle initial request with no state or mismatched state in a callback by starting authorization request.
      if (searchParams.get("state") !== authURL.searchParams.get("state")) {
        await req.respond({
          status: 307,
          headers: new Headers({
            "content-type": `text/plain; charset=utf-8`,
            location: authURL.href,
          }),
          body: `Redirecting to ${authURL}\r\n`,
        });
        continue;
      }

      // No error and state matches: assume all is well and clean up the server.
      await req.respond({
        status: 200,
        headers: new Headers({
          "content-type": `text/plain; charset=utf-8`,
        }),
        body: `Success! You can close this window.\r\n`,
      });

      server.close();

      code = searchParams.get("code");
    }

    if (!code) {
      throw new Error(`No code recieved from accounts service`);
    }

    /**
     * [PKCE Authorization Step 4. Your app exchanges the code for an access token][1]
     *
     * > If the user accepted your request, then your app is ready to exchange the authorization code for an access token. It can do this by making a POST request to the `https://accounts.spotify.com/api/token` endpoint.
     *
     * [1]: https://developer.spotify.com/documentation/general/guides/authorization-guide/#4-your-app-exchanges-the-code-for-an-access-token
     */
    return AccessToken.create(this, `authorization_code`, {
      code: code,
      code_verifier: codeVerifier,
      redirect_uri: this.#callback.href,
    });
  }
}

/**
 * A successful response from `https://accounts.spotify.com/api/token`.
 */
interface AccessTokenResponse {
  /** An access token that can be provided in subsequent calls to Spotify’s Web API. */
  readonly access_token: string;
  /** How the access token may be used: always “Bearer”. */
  readonly token_type: "Bearer";
  /** A space-separated list of scopes which have been granted for this `access_token` */
  readonly scope: string;
  /** The time period (in seconds) for which the access token is valid. */
  readonly expires_in: number;
  /** A token that can be sent to the Spotify Accounts service in place of an authorization code. */
  readonly refresh_token: string;
}

/**
 * An access token that can be provided in subsequent calls to Spotify’s Web API.
 */
class AccessToken {
  /**
   * Requests an access token with parameters specific to a given grant type.
   */
  static async create(
    client: SpotifyPKCEClient,
    grantType: string,
    params: Record<string, string>
  ) {
    const response = await fetch(`https://accounts.spotify.com/api/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: client.id,
        grant_type: grantType,
        ...params,
      }),
    });
    const { error, ...data } = await response.json();
    if (error) {
      throw new Error(`${error}: ${data.error_description}`);
    } else {
      return new AccessToken(client, data);
    }
  }

  readonly #client: SpotifyPKCEClient;
  readonly #value: string;
  readonly #type: "Bearer";
  readonly #expiresIn: number;
  readonly #refreshToken: string;

  /** Time at which this instance was created. Used to infer the time of expiry. */
  readonly #createdAt = Date.now();

  private constructor(
    client: SpotifyPKCEClient,
    response: AccessTokenResponse
  ) {
    this.#client = client;
    this.#value = response.access_token;
    this.#type = response.token_type;
    this.#expiresIn = response.expires_in;
    this.#refreshToken = response.refresh_token;
  }

  /** Returns false if the token has expired. see {@link AccessToken} */
  isValid() {
    return this.#createdAt + this.#expiresIn * 1000 > Date.now();
  }

  /**
   * Fetchs a resource from the network using this token to provide authorization, and resolves to the JSON response of that request. If the response contains an `error` object, the request fails with an Error containing the `message` property of that object.
   *
   * @param url Resolved relative to `https://api.spotify.com/v1/`.
   */
  async fetch(url: URL | string, init?: RequestInit) {
    /**
     * [PKCE Authorization Step 5. Use the access token to access the Spotify Web API][1]
     *
     * [1]: https://developer.spotify.com/documentation/general/guides/authorization-guide/#5-use-the-access-token-to-access-the-spotify-web-api
     */
    const response = await fetch(new URL(url, `https://api.spotify.com/v1/`), {
      ...init,
      headers: [
        ...new Headers(init?.headers),
        ["Authorization", `${this.#type} ${this.#value}`],
      ],
    });
    const { error, ...data } = await response.json();
    if (error) {
      throw new Error(error.message);
    } else {
      return data;
    }
  }

  /**
   * [6. Requesting a refreshed access token][1]
   *
   * > Access tokens expire after a short time, after which new tokens may be granted by using a valid refresh token.
   *
   * [1]: https://developer.spotify.com/documentation/general/guides/authorization-guide/#6-requesting-a-refreshed-access-token
   */
  refresh() {
    return AccessToken.create(this.#client, `refresh_token`, {
      refresh_token: this.#refreshToken,
    });
  }
}
