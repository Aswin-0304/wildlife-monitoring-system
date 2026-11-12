package com.wildlife;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wildlife.entity.UserAccount;
import com.wildlife.entity.UserRole;
import com.wildlife.repository.RevokedJwtRepository;
import com.wildlife.repository.UserAccountRepository;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.security.SecureRandom;
import java.util.Base64;

import static org.hamcrest.Matchers.containsString;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Runs the API in its production cookie mode (app.security.cookie-secure=true): the SPA on Cloudflare Pages and the API
 * on Render are different sites, so the CSRF and auth cookies must be SameSite=None; Secure.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class AuthenticationIntegrationTest {
    static final String PASSWORD = "A-Strong-Test-Password-2026";
    static final String FRONTEND_ORIGIN = "https://zovive-wms-site.pages.dev";
    private static final String FORBIDDEN_MESSAGE = "You do not have permission to access this resource.";
    private static final String TEST_JWT_SECRET = createTestSecret();

    @DynamicPropertySource
    static void securityTestProperties(DynamicPropertyRegistry properties) {
        properties.add("app.security.jwt-secret", () -> TEST_JWT_SECRET);
        properties.add("app.security.cookie-secure", () -> true);
        properties.add("app.cors.origins", () -> FRONTEND_ORIGIN + ",http://localhost:5173");
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired UserAccountRepository users;
    @Autowired RevokedJwtRepository revokedTokens;
    @Autowired PasswordEncoder passwordEncoder;

    @BeforeEach
    void seedAccounts() {
        users.deleteAll();
        createUser("field-admin", "admin@example.test", UserRole.ADMIN);
        createUser("field-officer", "officer@example.test", UserRole.FOREST_OFFICER);
    }

    @Test
    void csrfEndpointReturnsRawTokenAndSetsMatchingCrossSiteCookie() throws Exception {
        MvcResult result = mvc.perform(get("/api/auth/csrf").header("Origin", FRONTEND_ORIGIN))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", FRONTEND_ORIGIN))
                .andExpect(header().string("Access-Control-Allow-Credentials", "true"))
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andReturn();
        String token = mapper.readTree(result.getResponse().getContentAsString()).get("token").asText();
        // CookieCsrfTokenRepository uses response.addCookie(); MockMvc's header omits SameSite, so read the Cookie
        // itself (AuthCookieWireFormatTest checks the header Tomcat actually sends).
        Cookie cookie = result.getResponse().getCookie("XSRF-TOKEN");

        assertFalse(token.isBlank());
        assertNotNull(cookie);
        // The body carries the same (unmasked) value as the cookie: the SPA cannot read the cross-site cookie itself.
        assertEquals(token, cookie.getValue());
        assertEquals("/", cookie.getPath());
        assertTrue(cookie.getSecure());
        assertEquals("None", cookie.getAttribute("SameSite"));
    }

    @Test
    void corsAllowsTheFrontendOriginWithCredentialsAndCsrfHeaderOnly() throws Exception {
        mvc.perform(options("/api/auth/login").header("Origin", FRONTEND_ORIGIN)
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers", "content-type,x-xsrf-token"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", FRONTEND_ORIGIN))
                .andExpect(header().string("Access-Control-Allow-Credentials", "true"))
                .andExpect(header().string("Access-Control-Allow-Headers", containsString("x-xsrf-token")));
        mvc.perform(options("/api/auth/login").header("Origin", "https://attacker.example")
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers", "content-type,x-xsrf-token"))
                .andExpect(status().isForbidden())
                .andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
    }

    @Test
    void validLoginUsesHttpOnlyCookieAndExposesNoTokenOrPassword() throws Exception {
        Csrf csrf = csrf();
        MvcResult result = mvc.perform(withCsrf(post("/api/auth/login"), csrf)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("identifier", "admin@example.test", "password", PASSWORD, "rememberMe", true))))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", FRONTEND_ORIGIN))
                .andExpect(header().string("Access-Control-Allow-Credentials", "true"))
                .andExpect(jsonPath("$.user.username").value("field-admin"))
                .andExpect(jsonPath("$.user.role").value("ADMIN"))
                .andExpect(jsonPath("$.token").doesNotExist())
                .andExpect(jsonPath("$.user.passwordHash").doesNotExist())
                .andReturn();

        String setCookie = setCookie(result, "ZOVIVE_AUTH");
        List<String> attributes = attributes(setCookie);
        assertTrue(attributes.contains("HttpOnly"), setCookie);
        assertTrue(attributes.contains("Secure"), setCookie);
        assertTrue(attributes.contains("SameSite=None"), setCookie);
        assertTrue(attributes.contains("Path=/api"), setCookie);
        assertTrue(attributes.contains("Max-Age=604800"), setCookie);
        assertFalse(setCookie.contains(PASSWORD));
    }

    @Test
    void loginWithoutRememberMeIssuesASessionCookie() throws Exception {
        Login session = login("field-admin", false);
        List<String> attributes = attributes(session.setCookie);
        assertTrue(attributes.contains("HttpOnly") && attributes.contains("Secure") && attributes.contains("SameSite=None"), session.setCookie);
        assertTrue(attributes.stream().noneMatch(attribute -> attribute.startsWith("Max-Age")), session.setCookie);
    }

    @Test
    void invalidCredentialsReturnGenericUnauthorizedAndNoCookie() throws Exception {
        Csrf csrf = csrf();
        for (Map<String, Object> credentials : List.<Map<String, Object>>of(
                Map.of("identifier", "field-admin", "password", "wrong-password", "rememberMe", false),
                Map.of("identifier", "unknown@example.test", "password", PASSWORD, "rememberMe", false))) {
            MvcResult result = mvc.perform(withCsrf(post("/api/auth/login"), csrf)
                            .contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(credentials)))
                    .andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.message").value("Invalid username/email or password."))
                    .andReturn();
            assertNoAuthCookie(result);
        }
    }

    @Test
    void loginWithoutTheCsrfCookieOrHeaderIsRejectedBeforeAuthentication() throws Exception {
        Csrf csrf = csrf();
        String validLogin = mapper.writeValueAsString(Map.of("identifier", "field-admin", "password", PASSWORD, "rememberMe", false));

        // What the browser sent in production: the token from the /csrf body in the header, but no XSRF-TOKEN cookie,
        // because a SameSite=Strict cookie from the API is never sent with the SPA's cross-site POST.
        assertNoAuthCookie(mvc.perform(post("/api/auth/login").header("Origin", FRONTEND_ORIGIN).header("X-XSRF-TOKEN", csrf.token)
                        .contentType(MediaType.APPLICATION_JSON).content(validLogin))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.message").value(FORBIDDEN_MESSAGE)).andReturn());
        // Cookie but no header.
        assertNoAuthCookie(mvc.perform(post("/api/auth/login").header("Origin", FRONTEND_ORIGIN).cookie(csrf.cookie)
                        .contentType(MediaType.APPLICATION_JSON).content(validLogin))
                .andExpect(status().isForbidden()).andReturn());
        // Neither.
        assertNoAuthCookie(mvc.perform(post("/api/auth/login").header("Origin", FRONTEND_ORIGIN)
                        .contentType(MediaType.APPLICATION_JSON).content(validLogin))
                .andExpect(status().isForbidden()).andReturn());

        // The same credentials succeed once the cookie and header are both present.
        mvc.perform(withCsrf(post("/api/auth/login"), csrf).contentType(MediaType.APPLICATION_JSON).content(validLogin))
                .andExpect(status().isOk());
    }

    @Test
    void loginWithAWrongCsrfTokenIsRejectedBeforeAuthentication() throws Exception {
        Csrf csrf = csrf();
        Csrf other = csrf();
        assertNotEquals(csrf.token, other.token);
        String validLogin = mapper.writeValueAsString(Map.of("identifier", "field-admin", "password", PASSWORD, "rememberMe", false));

        for (String wrongToken : new String[]{"not-the-token", other.token}) {
            assertNoAuthCookie(mvc.perform(post("/api/auth/login").header("Origin", FRONTEND_ORIGIN)
                            .cookie(csrf.cookie).header("X-XSRF-TOKEN", wrongToken)
                            .contentType(MediaType.APPLICATION_JSON).content(validLogin))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.message").value(FORBIDDEN_MESSAGE)).andReturn());
        }
    }

    @Test
    void adminSessionReachesMeDashboardAndAdminRoutes() throws Exception {
        Login admin = login("field-admin", false);
        mvc.perform(get("/api/auth/me").header("Origin", FRONTEND_ORIGIN).cookie(admin.authCookie))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value("field-admin"))
                .andExpect(jsonPath("$.role").value("ADMIN"));
        mvc.perform(get("/api/dashboard/stats").cookie(admin.authCookie)).andExpect(status().isOk());
        mvc.perform(get("/api/admin/users").cookie(admin.authCookie)).andExpect(status().isOk());
    }

    @Test
    void protectedRoutesRejectAnonymousRequests() throws Exception {
        for (String path : new String[]{"/api/auth/me", "/api/dashboard/stats", "/api/admin/users", "/api/detections"}) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.message").value("Authentication required."));
        }
        // A valid CSRF token is not a substitute for authentication.
        Csrf csrf = csrf();
        mvc.perform(withCsrf(post("/api/admin/users"), csrf).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"new-officer\",\"email\":\"new-officer@example.test\",\"password\":\"A-Strong-Test-Password-2026\",\"role\":\"FOREST_OFFICER\"}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void logoutExpiresTheCookieWithMatchingAttributesAndRevokesTheToken() throws Exception {
        Login admin = login("field-admin", true);
        MvcResult result = mvc.perform(withCsrf(post("/api/auth/logout"), admin.csrf).cookie(admin.authCookie))
                .andExpect(status().isNoContent())
                .andExpect(header().string("Cache-Control", containsString("no-store")))
                .andReturn();
        String expired = setCookie(result, "ZOVIVE_AUTH");
        assertTrue(expired.startsWith("ZOVIVE_AUTH=;"), expired);
        List<String> attributes = attributes(expired);
        // A browser only deletes the cookie when the name, path and attributes match the cookie it holds.
        assertTrue(attributes.containsAll(List.of("Max-Age=0", "Path=/api", "HttpOnly", "Secure", "SameSite=None")), expired);

        mvc.perform(get("/api/auth/me").cookie(admin.authCookie)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/admin/users").cookie(admin.authCookie)).andExpect(status().isUnauthorized());
        // Logout keeps its CSRF protection.
        mvc.perform(post("/api/auth/logout").cookie(admin.authCookie)).andExpect(status().isForbidden());
    }

    @Test
    void dashboardSignOutRevokesTheJwtAndEndsTheSession() throws Exception {
        Login admin = login("field-admin", true);
        mvc.perform(get("/api/dashboard/stats").cookie(admin.authCookie)).andExpect(status().isOk());
        long revokedBefore = revokedTokens.count();

        // The SPA's sign-out: fetch a fresh CSRF token while signed in, then POST /logout with both cookies and the header.
        MvcResult csrfResult = mvc.perform(get("/api/auth/csrf").header("Origin", FRONTEND_ORIGIN).cookie(admin.authCookie, admin.csrf.cookie))
                .andExpect(status().isOk()).andReturn();
        String token = mapper.readTree(csrfResult.getResponse().getContentAsString()).get("token").asText();
        assertEquals(admin.csrf.token, token, "an existing XSRF-TOKEN cookie is reused, so the header and cookie match");
        MvcResult logout = mvc.perform(post("/api/auth/logout").header("Origin", FRONTEND_ORIGIN)
                        .cookie(admin.authCookie, admin.csrf.cookie).header("X-XSRF-TOKEN", token))
                .andExpect(status().isNoContent())
                .andExpect(header().string("Access-Control-Allow-Origin", FRONTEND_ORIGIN))
                .andExpect(header().string("Access-Control-Allow-Credentials", "true"))
                .andReturn();
        assertTrue(attributes(setCookie(logout, "ZOVIVE_AUTH")).containsAll(List.of("Max-Age=0", "Path=/api", "HttpOnly", "Secure", "SameSite=None")));

        // The JWT is revoked server-side, so even a browser that kept the cookie cannot reach protected routes.
        assertEquals(revokedBefore + 1, revokedTokens.count());
        for (String path : new String[]{"/api/auth/me", "/api/dashboard/stats", "/api/admin/users"}) {
            mvc.perform(get(path).cookie(admin.authCookie)).andExpect(status().isUnauthorized());
        }
    }

    @Test
    void logoutRevokesTheTokenAndOfficerCannotUseAdminRoutes() throws Exception {
        Login officer = login("field-officer", false);
        mvc.perform(get("/api/auth/me").cookie(officer.authCookie))
                .andExpect(status().isOk()).andExpect(jsonPath("$.role").value("FOREST_OFFICER"));
        mvc.perform(get("/api/admin/users").cookie(officer.authCookie)).andExpect(status().isForbidden());
        mvc.perform(post("/api/admin/users").cookie(officer.authCookie, officer.csrf.cookie)
                        .header("X-XSRF-TOKEN", officer.csrf.token).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"new-officer\",\"email\":\"new-officer@example.test\",\"password\":\"A-Strong-Test-Password-2026\",\"role\":\"FOREST_OFFICER\"}"))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/auth/logout").cookie(officer.authCookie, officer.csrf.cookie)
                        .header("X-XSRF-TOKEN", officer.csrf.token))
                .andExpect(status().isNoContent())
                .andExpect(header().string("Set-Cookie", containsString("Max-Age=0")));
        mvc.perform(get("/api/auth/me").cookie(officer.authCookie)).andExpect(status().isUnauthorized());

        Login admin = login("field-admin", false);
        mvc.perform(get("/api/admin/users").cookie(admin.authCookie))
                .andExpect(status().isOk()).andExpect(jsonPath("$[0].role").exists());
        mvc.perform(post("/api/admin/users").cookie(admin.authCookie, admin.csrf.cookie)
                        .header("X-XSRF-TOKEN", admin.csrf.token).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"new-officer\",\"email\":\"new-officer@example.test\",\"password\":\"A-Strong-Test-Password-2026\",\"role\":\"FOREST_OFFICER\"}"))
                .andExpect(status().isCreated()).andExpect(jsonPath("$.role").value("FOREST_OFFICER"))
                .andExpect(jsonPath("$.passwordHash").doesNotExist());
    }

    @Test
    void staleOrRevokedCookieNeverBlocksCsrfLoginOrLogout() throws Exception {
        // A cookie signed with another key (e.g. before a backend restart) and a cookie already revoked by logout.
        Cookie foreign = new Cookie("ZOVIVE_AUTH", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaWVsZC1hZG1pbiIsImlzcyI6Inpvdml2ZS1hcGkifQ.c2lnbmVkLXdpdGgtYW4tb2xkLWtleQ");
        foreign.setPath("/api");
        Login session = login("field-officer", false);
        mvc.perform(post("/api/auth/logout").cookie(session.authCookie, session.csrf.cookie).header("X-XSRF-TOKEN", session.csrf.token))
                .andExpect(status().isNoContent());

        for (Cookie stale : new Cookie[]{foreign, session.authCookie}) {
            MvcResult csrfResult = mvc.perform(get("/api/auth/csrf").cookie(stale)).andExpect(status().isOk()).andReturn();
            Csrf csrf = new Csrf(mapper.readTree(csrfResult.getResponse().getContentAsString()).get("token").asText(),
                    csrfResult.getResponse().getCookie("XSRF-TOKEN"));
            // Logout still answers 204 and expires the cookie, even though the token is invalid.
            mvc.perform(post("/api/auth/logout").cookie(stale, csrf.cookie).header("X-XSRF-TOKEN", csrf.token))
                    .andExpect(status().isNoContent())
                    .andExpect(header().string("Set-Cookie", containsString("Max-Age=0")));
            // Correct credentials still sign in while the stale cookie is present.
            mvc.perform(post("/api/auth/login").cookie(stale, csrf.cookie).header("X-XSRF-TOKEN", csrf.token)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(mapper.writeValueAsString(Map.of("identifier", "field-admin", "password", PASSWORD, "rememberMe", false))))
                    .andExpect(status().isOk()).andExpect(jsonPath("$.user.username").value("field-admin"));
            // Protected routes still reject the stale token, and logout still requires the CSRF token.
            mvc.perform(get("/api/auth/me").cookie(stale)).andExpect(status().isUnauthorized());
            mvc.perform(post("/api/auth/logout").cookie(stale)).andExpect(status().isForbidden());
        }
    }

    @Test
    void forestOfficerCanUseExistingMonitoringAndCrudApis() throws Exception {
        Login officer = login("field-officer", false);
        Cookie[] authAndCsrf = {officer.authCookie, officer.csrf.cookie};
        String csrfHeader = officer.csrf.token;

        mvc.perform(get("/api/dashboard/stats").cookie(officer.authCookie)).andExpect(status().isOk());
        mvc.perform(get("/api/detections").cookie(officer.authCookie)).andExpect(status().isOk());
        mvc.perform(get("/api/cameras").cookie(officer.authCookie)).andExpect(status().isOk());
        mvc.perform(get("/api/alerts").cookie(officer.authCookie)).andExpect(status().isOk());

        String detection = "{\"species\":\"Wolf\",\"confidence\":91.5,\"location\":\"West Ridge\",\"detectedAt\":\"2026-11-07T12:30:00\"}";
        MvcResult createdDetection = mvc.perform(post("/api/detections").cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader)
                        .contentType(MediaType.APPLICATION_JSON).content(detection))
                .andExpect(status().isCreated()).andReturn();
        long detectionId = mapper.readTree(createdDetection.getResponse().getContentAsString()).get("id").asLong();
        mvc.perform(put("/api/detections/{id}", detectionId).cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader)
                        .contentType(MediaType.APPLICATION_JSON).content(detection.replace("Wolf", "Fox")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.species").value("Fox"));
        mvc.perform(delete("/api/detections/{id}", detectionId).cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader))
                .andExpect(status().isNoContent());

        String camera = "{\"cameraName\":\"Test camera\",\"location\":\"East Ridge\",\"status\":\"ACTIVE\"}";
        MvcResult createdCamera = mvc.perform(post("/api/cameras").cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader)
                        .contentType(MediaType.APPLICATION_JSON).content(camera))
                .andExpect(status().isCreated()).andReturn();
        long cameraId = mapper.readTree(createdCamera.getResponse().getContentAsString()).get("id").asLong();
        mvc.perform(put("/api/cameras/{id}", cameraId).cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader)
                        .contentType(MediaType.APPLICATION_JSON).content(camera.replace("ACTIVE", "INACTIVE")))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("INACTIVE"));
        mvc.perform(delete("/api/cameras/{id}", cameraId).cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader))
                .andExpect(status().isNoContent());

        MvcResult createdAlert = mvc.perform(post("/api/alerts").cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"alertType\":\"Test movement\",\"detectionId\":null}"))
                .andExpect(status().isCreated()).andReturn();
        long alertId = mapper.readTree(createdAlert.getResponse().getContentAsString()).get("id").asLong();
        mvc.perform(put("/api/alerts/{id}", alertId).cookie(authAndCsrf).header("X-XSRF-TOKEN", csrfHeader)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"RESOLVED\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("RESOLVED"));
    }

    private void createUser(String username, String email, UserRole role) {
        UserAccount user = new UserAccount();
        user.setUsername(username); user.setEmail(email); user.setPasswordHash(passwordEncoder.encode(PASSWORD));
        user.setRole(role); user.setEnabled(true); users.save(user);
    }

    private static String createTestSecret() {
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        return Base64.getEncoder().encodeToString(secret);
    }

    /** A cross-site request from the SPA carrying the CSRF cookie and the matching X-XSRF-TOKEN header. */
    private static MockHttpServletRequestBuilder withCsrf(MockHttpServletRequestBuilder request, Csrf csrf) {
        return request.header("Origin", FRONTEND_ORIGIN).cookie(csrf.cookie).header("X-XSRF-TOKEN", csrf.token);
    }

    static String setCookie(MvcResult result, String name) {
        return result.getResponse().getHeaders("Set-Cookie").stream()
                .filter(value -> value.startsWith(name + "=")).findFirst()
                .orElseThrow(() -> new AssertionError("No Set-Cookie for " + name));
    }

    static List<String> attributes(String setCookie) {
        return Arrays.stream(setCookie.split(";")).skip(1).map(String::trim).toList();
    }

    private static void assertNoAuthCookie(MvcResult result) {
        assertTrue(result.getResponse().getHeaders("Set-Cookie").stream().noneMatch(value -> value.startsWith("ZOVIVE_AUTH=")),
                "The request must not reach the login controller");
    }

    private Csrf csrf() throws Exception {
        MvcResult result = mvc.perform(get("/api/auth/csrf").header("Origin", FRONTEND_ORIGIN)).andExpect(status().isOk()).andReturn();
        JsonNode json = mapper.readTree(result.getResponse().getContentAsString());
        return new Csrf(json.get("token").asText(), result.getResponse().getCookie("XSRF-TOKEN"));
    }

    private Login login(String identifier, boolean rememberMe) throws Exception {
        Csrf csrf = csrf();
        MvcResult result = mvc.perform(withCsrf(post("/api/auth/login"), csrf)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("identifier", identifier, "password", PASSWORD, "rememberMe", rememberMe))))
                .andExpect(status().isOk()).andReturn();
        String setCookie = setCookie(result, "ZOVIVE_AUTH");
        Cookie authCookie = new Cookie("ZOVIVE_AUTH", setCookie.substring("ZOVIVE_AUTH=".length(), setCookie.indexOf(';')));
        authCookie.setPath("/api");
        return new Login(authCookie, csrf, setCookie);
    }

    private record Csrf(String token, Cookie cookie) { }
    private record Login(Cookie authCookie, Csrf csrf, String setCookie) { }
}
