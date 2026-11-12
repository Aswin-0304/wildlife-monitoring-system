package com.wildlife;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wildlife.entity.UserAccount;
import com.wildlife.entity.UserRole;
import com.wildlife.repository.UserAccountRepository;
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

import java.util.List;
import java.util.Map;

import static com.wildlife.AuthenticationIntegrationTest.attributes;
import static com.wildlife.AuthenticationIntegrationTest.setCookie;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Local development over plain HTTP (AUTH_COOKIE_SECURE=false) is same-site and keeps SameSite=Strict cookies. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class LocalHttpCookieAttributesTest {
    @DynamicPropertySource
    static void localHttpProperties(DynamicPropertyRegistry properties) {
        byte[] secret = new byte[32];
        new java.security.SecureRandom().nextBytes(secret);
        properties.add("app.security.jwt-secret", () -> java.util.Base64.getEncoder().encodeToString(secret));
        properties.add("app.security.cookie-secure", () -> false);
        properties.add("spring.datasource.url", () -> "jdbc:h2:mem:wildlife-auth-local;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired UserAccountRepository users;
    @Autowired PasswordEncoder passwordEncoder;

    @Test
    void cookiesAreStrictAndNotSecure() throws Exception {
        users.deleteAll();
        UserAccount admin = new UserAccount();
        admin.setUsername("local-admin"); admin.setEmail("local-admin@example.test");
        admin.setPasswordHash(passwordEncoder.encode(AuthenticationIntegrationTest.PASSWORD));
        admin.setRole(UserRole.ADMIN); admin.setEnabled(true); users.save(admin);

        MvcResult csrfResult = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        String token = mapper.readTree(csrfResult.getResponse().getContentAsString()).get("token").asText();
        jakarta.servlet.http.Cookie csrfCookie = csrfResult.getResponse().getCookie("XSRF-TOKEN");
        assertEquals("Strict", csrfCookie.getAttribute("SameSite"));
        assertFalse(csrfCookie.getSecure());

        MvcResult login = mvc.perform(post("/api/auth/login").cookie(csrfResult.getResponse().getCookie("XSRF-TOKEN"))
                        .header("X-XSRF-TOKEN", token).contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("identifier", "local-admin", "password", AuthenticationIntegrationTest.PASSWORD, "rememberMe", false))))
                .andExpect(status().isOk()).andReturn();
        List<String> authCookie = attributes(setCookie(login, "ZOVIVE_AUTH"));
        assertTrue(authCookie.containsAll(List.of("HttpOnly", "SameSite=Strict", "Path=/api")), authCookie::toString);
        assertFalse(authCookie.contains("Secure"), authCookie::toString);
    }
}
