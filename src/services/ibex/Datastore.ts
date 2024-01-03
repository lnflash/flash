import { SignInResponse200 } from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>


export interface Datastore {
    set(tokens: SignInResponse200): void;
    getAccessToken(): string | undefined;
    setAccessToken(token: string): void;
    getRefreshToken(): string | undefined;
    // setRefreshToken(token: string): void;
}

// Use @cache/local-cache?. Uses node-cache. any advantages?
export class InMemoryDatastore implements Datastore {
    private accessToken: string | undefined = undefined;
    private accessTokenExpiresAt: number | undefined = undefined;
    private refreshToken: string | undefined = undefined;
    private refreshTokenExpiresAt: number | undefined = undefined;

    set(tokens: SignInResponse200): void {
        this.accessToken = tokens.accessToken
        this.accessTokenExpiresAt = tokens.accessTokenExpiresAt
        this.refreshToken = tokens.refreshToken
        this.refreshTokenExpiresAt = tokens.refreshTokenExpiresAt
    }

    getAccessToken(): string | undefined {
        return this.accessToken;
    }

    setAccessToken(token: string): void {
        this.accessToken = token;
    }

    getRefreshToken(): string | undefined {
        return this.refreshToken;
    }

    // setRefreshToken(token: string): void {
    //     this.refreshToken = token;
    // }
}


// export class RedisDatastore

