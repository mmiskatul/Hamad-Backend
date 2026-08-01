# Hamad Backend

Fastify 5 + TypeScript API for OneAI Hub, backed by MongoDB.

## Structure

src/
  app.ts               Fastify application factory
  index.ts             Server entry point
  config/              Environment and application configuration
  modules/auth/        Registration, login, and MongoDB repository
  modules/email/       SMTP verification-email delivery
  routes/              HTTP route plugins
tests/                 Node test runner tests

## Run locally

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env`, start MongoDB, then run the server. It listens
on http://localhost:4000 by default. Before registration can send a code, fill
in `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM_EMAIL` in `.env`.
MongoDB Atlas is supported through a `mongodb+srv://` URL. Set
`MONGODB_DNS_SERVERS` only when the host system cannot resolve Atlas SRV records.

- GET / returns service metadata
- GET /api/v1/health returns the health status
- POST /api/v1/auth/check-email checks whether an account exists
- POST /api/v1/auth/registration/request-code emails a four-digit verification code
- POST /api/v1/auth/registration/verify-code exchanges the code for a one-time registration proof
- POST /api/v1/auth/registration creates the user and starts a 30-day session
- POST /api/v1/auth/login validates email/password and starts a 30-day session
- POST /api/v1/auth/refresh rotates the refresh token and returns a new access token
- POST /api/v1/auth/logout revokes a session token
- GET /api/v1/auth/sessions lists the user's active sessions
- DELETE /api/v1/auth/sessions/:sessionId revokes one of the user's sessions
- GET /api/v1/auth/me returns the JWT-authenticated user

Passwords are stored as salted scrypt hashes. Email verification codes and
one-time registration proofs are HMAC-hashed and expire automatically through a
MongoDB TTL index. The API never returns the emailed code in a response.

Registration, login, and refresh responses use the same token shape:
`accessToken`, `refreshToken`, `sessionToken`, `tokenType`, `expiresIn`, and
`sessionExpiresAt`. Access JWTs expire after 15 minutes. The opaque refresh token
is rotated on every refresh and the separate session token has a server-enforced
30-day absolute expiry. Only HMAC hashes of the opaque tokens are stored in
MongoDB.

Send the access token to protected endpoints as
`Authorization: Bearer <accessToken>`. When it expires, refresh without an access
token:

```http
POST /api/v1/auth/refresh
Content-Type: application/json

{
  "refreshToken": "rt_...",
  "sessionToken": "st_..."
}
```

Replace both the access token and refresh token with the values in the response;
the session token remains stable. Clients must serialize refresh calls because
reuse of an already-rotated refresh token revokes that session. If refresh returns
`INVALID_SESSION`, clear all three tokens and require login. Mobile clients must
store refresh and session tokens in encrypted secure storage, not AsyncStorage.

Production startup rejects missing SMTP credentials and weak or placeholder JWT
secrets. `SMTP_SECURE=false` is correct for STARTTLS on port 587; use port 465
with `SMTP_SECURE=true` for implicit TLS.

## Docker

Start the development container with source-code hot reload:

```bash
docker compose up --build
```

Build the minimal non-root production image separately:

```bash
docker build --target production -t one-ai-hub-backend .
```

The Compose service reads private runtime values from `.env`. The production
image never copies `.env` into an image layer; provide the same variables through
your deployment platform's secret/environment configuration.
