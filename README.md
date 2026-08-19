# mcp-memory-server-lambda

A lightweight, stateless MCP server for exposing private long-term memory to **Claude.ai custom connectors**.

The server runs on AWS Lambda and retrieves memory from Neon PostgreSQL using `pgvector` hybrid search, with Gemini used for query embeddings.

## What It Does

This MCP server provides Claude with controlled access to a user's private HKSoka memory store.

It exposes four tools:

* `memory_search` — semantic/hybrid search across learned memories and seed documents
* `seed_list` — list available seed memory documents
* `seed_get` — retrieve a seed document with explicit offset-based paging
* `conversation_search` — exact keyword search across the user's stored conversation transcripts

The server is designed for a private, single-user deployment. The MCP endpoint itself does not expose memory data until a request passes the secret-URL authentication layer.

## Architecture

```text
Claude.ai
   │
   │ MCP Streamable HTTP
   ▼
AWS Lambda
   │
   ├── Secret URL authentication
   │
   ├── MCP protocol handling
   │
   └── Tool execution
   │
   ├───────────────┐
   ▼               ▼
Gemini          Neon PostgreSQL
Embedding API       │
                    ├── memory seeds
                    ├── learned memories
                    ├── conversations
                    └── pgvector / hybrid retrieval
```

### Memory Search

`memory_search` follows a two-pool retrieval model:

1. The query is embedded with Gemini.
2. The embedding and original text query are passed to the PostgreSQL hybrid retrieval function.
3. Seed documents and learned memories are retrieved separately.
4. Results are returned with a per-pool limit.

This keeps curated seed documents and automatically learned memory in distinct result pools.

## MCP Tools

### `memory_search`

Semantic/hybrid search over long-term memory.

```text
query
top_k
```

Returns:

* seed memory results
* learned memory results
* result counts
* a zero-result hint when appropriate

Use this for conceptual or semantic queries such as past decisions, projects, bugs, or context.

### `seed_list`

Lists the available seed documents.

Returns metadata including:

* document name
* active status
* whether it is automatically generated
* character count
* creation timestamp

### `seed_get`

Retrieves the raw contents of a seed document.

Supports offset-based paging:

```text
name
offset
max_chars
```

Every response includes:

```text
total_chars
offset
returned_chars
truncated
next_offset
```

When `truncated` is `true`, the client can continue from `next_offset`.

### `conversation_search`

Performs case-insensitive keyword search over stored conversation transcripts.

Returns:

* conversation ID
* conversation name
* update timestamp
* matching JSON snippet

Concealed/deleted conversations are excluded.

This tool is intended for exact terms such as error messages, filenames, feature names, or other known strings. Semantic searches should use `memory_search`.

## Deployment

### Requirements

* Node.js
* AWS Lambda
* AWS Lambda Function URL
* Neon PostgreSQL
* `pgvector`
* Gemini Embedding API
* An existing MCP-compatible client such as Claude.ai

### Environment Variables

Configure the Lambda function with:

| Variable         | Description                                        |
| ---------------- | -------------------------------------------------- |
| `DATABASE_URL`   | Neon PostgreSQL connection string                  |
| `GEMINI_API_KEY` | Gemini API key used for query embeddings           |
| `MCP_TOKEN`      | Secret used as the MCP endpoint path token         |
| `MCP_USER_ID`    | User ID whose memory is exposed by this deployment |

Example:

```text
DATABASE_URL=...
GEMINI_API_KEY=...
MCP_TOKEN=...
MCP_USER_ID=...
```

Keep these values in the Lambda environment configuration or an appropriate AWS secret-management mechanism. Do not commit them to the repository.

### AWS Lambda

Deploy the handler to an AWS Lambda function and configure a **Lambda Function URL** with the appropriate invocation settings.

The server expects requests at:

```text
/mcp/<MCP_TOKEN>
```

Only `POST` requests are accepted.

The server is stateless and does not maintain MCP sessions between requests.

## Connecting to Claude.ai

Claude.ai can connect to the deployed endpoint as a custom MCP connector.

Use the production MCP endpoint:

```text
https://<your-lambda-function-url>/mcp/<MCP_TOKEN>
```

Add this endpoint as a custom connector in Claude.ai.

Once connected, Claude can discover the available tools through MCP:

```text
memory_search
seed_list
seed_get
conversation_search
```

The endpoint should remain private and the token should be treated as a credential.

## Design Decisions

### Stateless

The server uses MCP Streamable HTTP without maintaining server-side sessions.

Each request independently contains the information required to process the MCP operation.

This fits the Lambda execution model and avoids session-state storage.

### Secret-URL Authentication

Authentication uses an exact path match:

```text
/mcp/<MCP_TOKEN>
```

Requests to other paths receive `404`.

The token is supplied through the Lambda environment rather than committed to source code.

The production endpoint itself should also remain private.

### Loud Truncation

Large seed documents are never silently truncated.

`seed_get` always reports:

* total document size
* current offset
* returned size
* whether more data exists
* the next offset

This allows an MCP client to deliberately page through large documents.

### Single-User v1

The current deployment resolves one user through:

```text
MCP_USER_ID
```

All database queries are scoped to this user.

The `resolveUser()` abstraction leaves room for a future token-to-user mapping without changing the tool interface.

### Two-Pool Retrieval

Memory retrieval deliberately separates:

```text
seed documents
learned memories
```

Each pool receives its own retrieval quota. This prevents one memory category from completely consuming the result set.

## Security Model

The server is intended for self-hosted private memory.

The source code contains the server implementation, while production credentials and user data remain outside the repository.

The primary access boundary is:

```text
Private production endpoint
        +
Secret MCP token
        +
Fixed MCP_USER_ID database scope
```

The server does not expose database credentials, embedding API credentials, or memory contents through the source repository.

## Project Scope

This repository contains the MCP server layer.

It assumes the underlying Neon database already contains the required memory tables, embeddings, and retrieval function used by the deployment.

The server is therefore best viewed as an **MCP adapter for an existing private memory system**, rather than a complete memory database implementation.

## License

MIT
