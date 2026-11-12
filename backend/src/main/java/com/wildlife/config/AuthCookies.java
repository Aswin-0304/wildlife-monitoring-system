package com.wildlife.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * The one place that decides the attributes of every cookie the API sets: the CSRF cookie and the HttpOnly JWT cookie.
 *
 * <p>In production the SPA (Cloudflare Pages) and the API (Render) are different sites, so the browser only stores these
 * cookies from, and sends them with, the SPA's credentialed {@code fetch} calls when they are {@code SameSite=None},
 * which browsers accept only together with {@code Secure}. With {@code SameSite=Strict} the CSRF cookie never reaches
 * {@code POST /api/auth/login} and Spring Security rejects the login with 403 before the controller runs.
 *
 * <p>Local development over plain HTTP ({@code app.security.cookie-secure=false}) is same-site, so it keeps
 * {@code SameSite=Strict} without {@code Secure}.
 */
@Component
public class AuthCookies {
    private final boolean secure;
    private final String sameSite;

    public AuthCookies(@Value("${app.security.cookie-secure:true}") boolean secure) {
        this.secure = secure;
        this.sameSite = secure ? "None" : "Strict";
    }

    /** Applies the shared Secure/SameSite attributes to a cookie (used by the CSRF token repository). */
    public ResponseCookie.ResponseCookieBuilder apply(ResponseCookie.ResponseCookieBuilder cookie) {
        return cookie.secure(secure).sameSite(sameSite);
    }

    /** The JWT cookie: HttpOnly, and only sent to the API's own paths. */
    public ResponseCookie.ResponseCookieBuilder auth(String token) {
        return apply(ResponseCookie.from(SecurityConfig.AUTH_COOKIE, token).httpOnly(true).path("/api"));
    }

    /** Deletes the JWT cookie. Its name, path and attributes must match the cookie being removed. */
    public ResponseCookie expiredAuth() {
        return auth("").maxAge(Duration.ZERO).build();
    }
}
