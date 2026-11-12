package com.wildlife;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wildlife.entity.UserAccount;
import com.wildlife.entity.UserRole;
import com.wildlife.repository.UserAccountRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static com.wildlife.AuthenticationIntegrationTest.FRONTEND_ORIGIN;
import static com.wildlife.AuthenticationIntegrationTest.PASSWORD;
import static com.wildlife.AuthenticationIntegrationTest.attributes;
import static org.junit.jupiter.api.Assertions.*;

/**
 * The browser flow over real HTTP against embedded Tomcat, checking the Set-Cookie headers exactly as they go on the
 * wire in production mode: CSRF token, login, /me, dashboard, logout.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class AuthCookieWireFormatTest {
    @DynamicPropertySource
    static void productionCookieProperties(DynamicPropertyRegistry properties) {
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        properties.add("app.security.jwt-secret", () -> Base64.getEncoder().encodeToString(secret));
        properties.add("app.security.cookie-secure", () -> true);
        properties.add("app.cors.origins", () -> FRONTEND_ORIGIN);
        properties.add("spring.datasource.url", () -> "jdbc:h2:mem:wildlife-auth-wire;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
    }

    @LocalServerPort int port;
    @Autowired ObjectMapper mapper;
    @Autowired UserAccountRepository users;
    @Autowired PasswordEncoder passwordEncoder;
    private final HttpClient http = HttpClient.newHttpClient();

    @Test
    void crossSiteBrowserFlowSendsSameSiteNoneSecureCookies() throws Exception {
        users.deleteAll();
        UserAccount admin = new UserAccount();
        admin.setUsername("wire-admin"); admin.setEmail("wire-admin@example.test");
        admin.setPasswordHash(passwordEncoder.encode(PASSWORD));
        admin.setRole(UserRole.ADMIN); admin.setEnabled(true); users.save(admin);

        // 1. GET /api/auth/csrf: token in the body, same value in a SameSite=None; Secure cookie.
        HttpResponse<String> csrf = send(request("/api/auth/csrf").GET());
        assertEquals(200, csrf.statusCode());
        assertEquals(FRONTEND_ORIGIN, csrf.headers().firstValue("Access-Control-Allow-Origin").orElse(null));
        assertEquals("true", csrf.headers().firstValue("Access-Control-Allow-Credentials").orElse(null));
        String token = mapper.readTree(csrf.body()).get("token").asText();
        String csrfCookie = setCookie(csrf, "XSRF-TOKEN");
        assertEquals("XSRF-TOKEN=" + token, csrfCookie.substring(0, csrfCookie.indexOf(';')));
        assertTrue(attributes(csrfCookie).containsAll(List.of("Path=/", "Secure", "SameSite=None")), csrfCookie);

        String login = mapper.writeValueAsString(Map.of("identifier", "wire-admin", "password", PASSWORD, "rememberMe", false));

        // 2. The production failure: header present but the cookie was not sent -> 403 before authentication.
        HttpResponse<String> blocked = send(request("/api/auth/login").header("Content-Type", "application/json")
                .header("X-XSRF-TOKEN", token).POST(HttpRequest.BodyPublishers.ofString(login)));
        assertEquals(403, blocked.statusCode());
        assertEquals("You do not have permission to access this resource.", mapper.readTree(blocked.body()).get("message").asText());

        // 3. Cookie + matching header -> 200 and an HttpOnly; Secure; SameSite=None auth cookie.
        HttpResponse<String> signedIn = send(request("/api/auth/login").header("Content-Type", "application/json")
                .header("Cookie", "XSRF-TOKEN=" + token).header("X-XSRF-TOKEN", token)
                .POST(HttpRequest.BodyPublishers.ofString(login)));
        assertEquals(200, signedIn.statusCode(), signedIn.body());
        assertEquals("ADMIN", mapper.readTree(signedIn.body()).at("/user/role").asText());
        String authCookie = setCookie(signedIn, "ZOVIVE_AUTH");
        assertTrue(attributes(authCookie).containsAll(List.of("Path=/api", "Secure", "HttpOnly", "SameSite=None")), authCookie);
        String auth = authCookie.substring(0, authCookie.indexOf(';'));

        // 4. The session reaches /me and the dashboard.
        HttpResponse<String> me = send(request("/api/auth/me").header("Cookie", auth).GET());
        assertEquals(200, me.statusCode());
        assertEquals("wire-admin", mapper.readTree(me.body()).get("username").asText());
        assertEquals(200, send(request("/api/dashboard/stats").header("Cookie", auth).GET()).statusCode());

        // 5. Logout expires the cookie with matching attributes and revokes the token.
        HttpResponse<String> logout = send(request("/api/auth/logout")
                .header("Cookie", auth + "; XSRF-TOKEN=" + token).header("X-XSRF-TOKEN", token)
                .POST(HttpRequest.BodyPublishers.noBody()));
        assertEquals(204, logout.statusCode());
        String expired = setCookie(logout, "ZOVIVE_AUTH");
        assertTrue(attributes(expired).containsAll(List.of("Max-Age=0", "Path=/api", "Secure", "HttpOnly", "SameSite=None")), expired);
        assertEquals(401, send(request("/api/auth/me").header("Cookie", auth).GET()).statusCode());
    }

    private HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).header("Origin", FRONTEND_ORIGIN);
    }

    private HttpResponse<String> send(HttpRequest.Builder request) throws Exception {
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String setCookie(HttpResponse<?> response, String name) {
        return response.headers().allValues("Set-Cookie").stream().filter(value -> value.startsWith(name + "=")).findFirst()
                .orElseThrow(() -> new AssertionError("No Set-Cookie for " + name + " in " + response.headers().map()));
    }
}
