# Optional multi-instance MCP gateway

Most users need only the ordinary single-instance Tunnel setup in [the installation guide](../docs/getting-started.md). Use this Worker only when you intentionally serve multiple independent MCP instances from one hostname.

Example routes using a domain **you own**:

| Public route | Origin setting |
| --- | --- |
| workspace.example.com/server* | SERVER_ORIGIN_HOST |
| workspace.example.com/group* | GROUP_ORIGIN_HOST |
| workspace.example.com/.well-known/oauth-authorization-server/server* | SERVER_ORIGIN_HOST |
| workspace.example.com/.well-known/oauth-protected-resource/server* | SERVER_ORIGIN_HOST |
| workspace.example.com/.well-known/oauth-authorization-server/group* | GROUP_ORIGIN_HOST |
| workspace.example.com/.well-known/oauth-protected-resource/group* | GROUP_ORIGIN_HOST |

Configure the two origin hostnames as private Worker environment settings before deploying ops/cloudflare-gateway-worker.mjs. Do not commit real origin names, Tunnel UUIDs, API tokens or account identifiers. The Worker fails closed if an origin setting is missing. Both HTTP-to-HTTPS and the original path/query are preserved, while origin fetches use HTTPS.

If a public static homepage uses the same hostname, route ordinary web paths directly to its origin. Keep only the six instance-specific Worker routes and do not expose the privileged local Console. Verify your own routing and OAuth discovery before removing any existing wildcard rule. Route changes in Cloudflare are separate from publishing a Control Release.
