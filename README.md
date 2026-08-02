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

Development logs use four consistent terminal events:

- `request started`: request id, HTTP method, path, and client IP
- `request completed`: HTTP status and duration
- `request rejected`: concise details for expected 4xx responses
- `request failed`: error details and stack trace for unexpected 5xx responses

Authorization headers and request bodies are intentionally excluded. Production
keeps machine-readable JSON logs for deployment log collectors.

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
- POST /api/v1/admin/auth/login validates an administrator and creates a session
- POST /api/v1/admin/auth/refresh rotates the administrator refresh token
- POST /api/v1/admin/auth/logout revokes the administrator session
- GET /api/v1/admin/auth/me validates the access token and active admin session
- GET /api/v1/admin/auth/sessions lists active administrator sessions
- DELETE /api/v1/admin/auth/sessions/:sessionId revokes an administrator session

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

For the first administrator, set `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, and
optionally `ADMIN_SEED_NAME` before starting the backend. Startup creates the
account only when the email does not exist; later startups never reset its
password. The password must contain at least 12 characters. Remove the seed
email and password from the runtime environment after the first successful
startup. The admin dashboard stores issued access, refresh, and session tokens
in separate HttpOnly cookies and refreshes the short-lived access token through
its server-side authentication gateway.

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

## AI gateway

The backend is the public API gateway for web and mobile traffic. It owns
authentication, users, payments, and notifications. Model discovery and generation
are delegated to the separate FastAPI service through `AI_SERVICE_BASE_URL`.
Provider API keys are configured only in `ai-agent/.env`.

```text
React / React Native
        |
API Gateway (Fastify)
        |
        +-- Authentication / Payments / Users / Notifications
        |
        +-- AI Service (FastAPI)
              +-- Chat / Model Router / Voice / RAG / Agents
        |
MongoDB + Redis
```

Set `AI_SERVICE_BASE_URL=http://localhost:8000/api/v1` to configure the required
internal AI service. Fastify also exposes `/api/v1/ai-service/*`; for example,
`/api/v1/ai-service/chat/responses` forwards to FastAPI `/api/v1/chat/responses`.

The backend also exposes two local TypeScript AI layers:

- Stateful chat: `POST /api/v1/conversations/:conversationId/messages` keeps conversation history in MongoDB and is what the mobile app uses today.
- Stateless AI gateway: `GET /api/v1/ai/models`, `POST /api/v1/ai/responses`, and `POST /api/v1/ai/chat/completions` let other clients use the FastAPI model router without managing conversations first.

Implementation layers:

- `src/modules/ai/modelRouter.ts` defines the internal AI request/response contract.
- `src/modules/ai/aiServiceRouter.ts` forwards model discovery and generation to FastAPI.
- `src/modules/ai/gatewayService.ts` loads user memory, invokes the router, and shapes responses.
- `src/routes/ai.ts` exposes the HTTP endpoints.

The gateway uses the authenticated user's saved memory when it exists, so the response style stays consistent with the profile section.
