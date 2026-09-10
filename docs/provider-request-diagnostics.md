# Provider request timing diagnostics

The source-managed ACP bridge observes the existing OpenAI-compatible HTTP client.
It does not change the model, reasoning effort, request body, retry policy, public
execution events, or the renderer's 30-second first-event deadline.

Empty ACP message metadata carries `baiqiu_diagnostic.type=provider_timing`.
The client consumes this metadata before public update callbacks; it cannot become
answer text, a tool event, or a meaningful event that resets the first-event deadline.
The main process writes it to `logs/cross-reply-trace-<pid>.jsonl` as
`output:providerTiming`, bound to the current session and turn.

| Stage | Meaning |
| --- | --- |
| client_prepare / client_ready | Native request client construction, with message/tool counts and serialized context character count |
| http_request | httpx request hook; request body byte count, before connection and sending |
| connection_connect_tcp_started / complete | Connection establishment |
| connection_start_tls_started / complete | TLS handshake |
| http11_send_request_body_complete / http2_send_request_body_complete | Request body sent |
| http11_receive_response_headers_started / http2_receive_response_headers_started | Waiting for HTTP response headers |
| http_headers | Actual response headers available, with HTTP status |
| first_byte | First nonempty raw response-body chunk; this can be an error or heartbeat and is not model text |
| stream_closed | Stream close and received byte count |

Preparation pairs have a local request ID; each HTTP request has its own local ID
shared by its transport, header, and body events. Cached HTTP clients retain no
diagnostic hooks after a prompt finishes. Existing trace hooks, stream bytes, and
native return values are preserved. Network reuse can omit TCP/TLS events.

Only allowlisted stages, generated IDs, numeric measurements, and fixed error
categories cross this channel. It does not log headers, credentials, commands,
request/response bodies, or reasoning content. Provider errors containing the
observed weekly limit reason carry `errorCategory=weekly_limit_exceeded`.
This identifies what the endpoint reported, not whether the restriction belongs
to the caller's account or the provider's shared upstream pool.

The instrumentation covers the bundled runtime's synchronous OpenAI-compatible
request client. External ACP launchers, other API modes, startup probes before
prompt callbacks are installed, and detached subagents are outside this coverage.
Cold session construction is separately measured by existing ACP timings.

Validated on 2026-09-08 with 20 JS checks and 5 Python checks, including unchanged
stream bytes, first-byte observation, safe metadata, hook restoration, and public
event separation. Live isolated requests returned a provider weekly-limit error;
no successful model generation was claimed in those samples. Source changes load
on the next client/runtime start; this investigation did not restart the user app.
