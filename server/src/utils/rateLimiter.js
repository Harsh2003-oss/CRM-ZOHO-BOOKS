class TokenBucketRateLimiter {
  constructor({ capacity = 100, refillRatePerSec = 1.666, name = 'DefaultLimiter' } = {}) {
    this.name = name;
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.lastRefillTimestamp = Date.now();
    this.pausedUntil = 0;
  }

  refill() {
    const now = Date.now();
    if (now < this.pausedUntil) {
      return;
    }

    const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillRatePerSec);
    this.lastRefillTimestamp = now;
  }

  pause(durationMs) {
    this.pausedUntil = Date.now() + durationMs;
    this.tokens = 0;
    console.warn(`[RATE LIMITER - ${this.name}] Paused for ${durationMs}ms`);
  }

  async acquire(tokensRequested = 1) {
    while (true) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        const waitMs = this.pausedUntil - now;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      this.refill();

      if (this.tokens >= tokensRequested) {
        this.tokens -= tokensRequested;
        return true;
      }

      const deficit = tokensRequested - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillRatePerSec) * 1000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 50)));
    }
  }

  getAvailableTokens() {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// 100 requests per minute for Zoho Books API v3
const zohoRateLimiter = new TokenBucketRateLimiter({
  capacity: 100,
  refillRatePerSec: 100 / 60,
  name: 'ZohoBooks'
});

// 10 requests per second (100 per 10s) for HubSpot Service Key
const hubspotRateLimiter = new TokenBucketRateLimiter({
  capacity: 10,
  refillRatePerSec: 10,
  name: 'HubSpot'
});

module.exports = {
  TokenBucketRateLimiter,
  zohoRateLimiter,
  hubspotRateLimiter
};

