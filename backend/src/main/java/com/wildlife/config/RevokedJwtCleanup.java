package com.wildlife.config;

import com.wildlife.repository.RevokedJwtRepository;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Component
public class RevokedJwtCleanup {
    private final RevokedJwtRepository revokedTokens;

    public RevokedJwtCleanup(RevokedJwtRepository revokedTokens) {
        this.revokedTokens = revokedTokens;
    }

    // A derived delete query loads and removes the matching rows, which JPA only allows inside a transaction.
    @Scheduled(fixedDelayString = "${app.security.revoked-token-cleanup-ms:3600000}")
    @Transactional
    public void removeExpiredRevocations() {
        revokedTokens.deleteByExpiresAtBefore(Instant.now());
    }
}
