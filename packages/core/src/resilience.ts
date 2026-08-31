/**
 * Error handling and resilience utilities.
 * Provides graceful degradation, retry logic, and error recovery helpers.
 */

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffFactor: 2.0,
};

/**
 * Retry a function with exponential backoff.
 * Useful for transient failures (network, database locks, etc).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...DEFAULT_RETRY_OPTIONS, ...opts };
  let lastError: Error | null = null;
  let delayMs = options.initialDelayMs;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      
      if (attempt < options.maxAttempts) {
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.1 * delayMs;
        const actualDelay = Math.min(delayMs + jitter, options.maxDelayMs);
        await new Promise((r) => setTimeout(r, actualDelay));
        delayMs = Math.min(delayMs * options.backoffFactor, options.maxDelayMs);
      }
    }
  }

  throw new Error(
    `Failed after ${options.maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

/**
 * Execute a function with a timeout. Throws TimeoutError if it takes too long.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        onTimeout?.();
        reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs),
    ),
  ]);
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Circuit breaker for handling repeated failures.
 * After too many failures, stops trying until the circuit "resets".
 */
export class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly failureThreshold = 5,
    private readonly resetTimeMs = 60000, // 1 minute
  ) {}

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): "closed" | "open" | "half-open" {
    if (this.state === "open") {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure > this.resetTimeMs) {
        this.state = "half-open";
      }
    }
    return this.state;
  }

  /**
   * Record a successful operation. Resets the circuit if half-open.
   */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  /**
   * Record a failed operation. Opens the circuit if threshold exceeded.
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }

  /**
   * Check if the circuit allows requests. Throws if open.
   */
  checkAllow(): void {
    const state = this.getState();
    if (state === "open") {
      throw new CircuitBreakerOpenError(
        `Circuit breaker is open (${this.failureCount} failures)`,
      );
    }
  }

  /**
   * Reset the circuit breaker manually.
   */
  reset(): void {
    this.failureCount = 0;
    this.state = "closed";
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

/**
 * Graceful degradation wrapper.
 * If the primary function fails, falls back to a secondary function.
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  onFallback?: (err: Error) => void,
): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    onFallback?.(err as Error);
    return await fallback();
  }
}

/**
 * Collect errors from multiple operations without short-circuiting.
 * Useful for operations that should continue despite partial failures.
 */
export async function executeAll<T>(
  operations: Array<{ name: string; fn: () => Promise<T> }>,
): Promise<{ results: T[]; errors: Array<{ name: string; error: Error }> }> {
  const results: T[] = [];
  const errors: Array<{ name: string; error: Error }> = [];

  for (const op of operations) {
    try {
      const result = await op.fn();
      results.push(result);
    } catch (err) {
      errors.push({ name: op.name, error: err as Error });
    }
  }

  return { results, errors };
}

/**
 * Safe error logging helper.
 * Prevents logging from throwing even if the error object is malformed.
 */
export function safeErrorToString(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ?? "no stack trace";
    return `${err.name}: ${err.message}\n${stack}`;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/**
 * Assert that a value is not null/undefined. Throws a descriptive error if it is.
 */
export function assertExists<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Assertion failed: ${message}`);
  }
  return value;
}

/**
 * Sentinel value wrapper for operations that might fail silently.
 * Distinguishes between "operation returned null" and "operation failed".
 */
export class Result<T, E> {
  private constructor(
    private readonly ok: boolean,
    private readonly value?: T,
    private readonly error?: E,
  ) {}

  static ok<T, E>(value: T): Result<T, E> {
    return new Result<T, E>(true, value);
  }

  static err<T, E>(error: E): Result<T, E> {
    return new Result<T, E>(false, undefined, error);
  }

  isOk(): boolean {
    return this.ok;
  }

  isErr(): boolean {
    return !this.ok;
  }

  unwrap(): T {
    if (this.ok) {
      return this.value as T;
    }
    throw new Error(`Tried to unwrap an Err: ${String(this.error)}`);
  }

  unwrapOr(defaultValue: T): T {
    return this.ok ? (this.value as T) : defaultValue;
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    if (this.ok) {
      return Result.ok(fn(this.value as T));
    }
    return Result.err(this.error as E);
  }

  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    if (this.ok) {
      return Result.ok(this.value as T);
    }
    return Result.err(fn(this.error as E));
  }
}

/**
 * Batch operations with rate limiting.
 * Useful for preventing resource exhaustion (e.g., embedding API calls).
 */
export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;

  constructor(
    private readonly tokensPerSecond: number,
    initialTokens?: number,
  ) {
    this.tokens = initialTokens ?? tokensPerSecond;
    this.lastRefillTime = Date.now();
  }

  /**
   * Wait until a token is available, then consume it.
   */
  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const timeSinceRefill = (now - this.lastRefillTime) / 1000;
      const tokensEarned = timeSinceRefill * this.tokensPerSecond;
      this.tokens = Math.min(this.tokens + tokensEarned, this.tokensPerSecond);
      this.lastRefillTime = now;

      if (this.tokens >= 1) {
        this.tokens--;
        return;
      }

      // Wait a bit before trying again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Try to acquire a token without waiting. Returns false if not available.
   */
  tryAcquire(): boolean {
    const now = Date.now();
    const timeSinceRefill = (now - this.lastRefillTime) / 1000;
    const tokensEarned = timeSinceRefill * this.tokensPerSecond;
    this.tokens = Math.min(this.tokens + tokensEarned, this.tokensPerSecond);
    this.lastRefillTime = now;

    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    return false;
  }
}

/**
 * Health check probe for monitoring.
 * Returns true if the probe succeeds, false otherwise.
 */
export async function healthCheck(
  probes: Array<{ name: string; fn: () => Promise<boolean> }>,
): Promise<{ healthy: boolean; results: Record<string, boolean> }> {
  const results: Record<string, boolean> = {};

  for (const probe of probes) {
    try {
      results[probe.name] = await Promise.race([
        probe.fn(),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 5000),
        ),
      ]);
    } catch {
      results[probe.name] = false;
    }
  }

  const healthy = Object.values(results).every((r) => r === true);
  return { healthy, results };
}
