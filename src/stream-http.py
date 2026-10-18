"""Private stdin-only, fixed-origin streaming HTTPS bridge for Dotter."""
import base64
import http.client
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def main():
    source = sys.stdin.buffer.read(1048577)
    if len(source) > 1048576:
        raise ValueError()
    args = json.loads(source)
    url = args.get("url", "")
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "chatgpt.com" or parsed.port
            or parsed.username or parsed.password or parsed.fragment
            or not parsed.path.startswith("/backend-api/")):
        raise ValueError()
    # The JS caller uses apiUrl too; repeat traversal protection at the boundary.
    if any(p in (".", "..") for p in urllib.parse.unquote(parsed.path).split("/")):
        raise ValueError()
    method = args.get("method", "GET")
    if method not in ("GET", "POST"):
        raise ValueError()
    headers = args.get("headers", {})
    allowed = {"authorization", "chatgpt-account-id", "accept", "content-type", "user-agent"}
    if not isinstance(headers, dict) or any(not isinstance(k, str) or k.lower() not in allowed
            or not isinstance(v, str) or "\r" in v or "\n" in v for k, v in headers.items()):
        raise ValueError()
    body = args.get("body")
    if body is not None and not isinstance(body, str):
        raise ValueError()
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(url, data=body.encode("utf-8") if body is not None else None,
                                     headers=headers, method=method)
    try:
        response = opener.open(request, timeout=65)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        safe_headers = {k.lower(): v for k, v in response.headers.items()
                        if k.lower() in {"content-type", "cf-ray", "cf-mitigated", "x-request-id", "x-openai-request-id", "content-encoding"}}
        if "content-encoding" in response.headers:
            safe_headers["content-encoding"] = ", ".join(response.headers.get_all("content-encoding"))
        header_record = {"type": "response", "status": response.status, "headers": safe_headers}
        # A definitive edge challenge must survive a broken or ambiguous body.
        if response.headers.get("cf-mitigated") == "challenge":
            emit(header_record)
            return
        try:
            # http.client otherwise accepts duplicate lengths or silently uses
            # EOF/chunked framing for malformed/conflicting length headers.
            lengths = response.headers.get_all("content-length", [])
            if (len(lengths) > 1 or lengths and
                    (not re.fullmatch(r"[0-9]+", lengths[0].strip())
                     or response.headers.get_all("transfer-encoding", []))):
                raise ValueError("ambiguous response framing")
            if lengths:
                int(lengths[0].strip())
        except Exception:
            if response.status not in (401, 403):
                raise
            emit(header_record)
            emit({"type": "error-body", "body": ""})
            return
        if response.status != 200:
            try:
                payload = response.read(65537)
                if len(payload) > 65536:
                    raise ValueError("error body too large")
                remaining = getattr(response, "length", None)
                if type(remaining) is int and remaining > 0:
                    raise http.client.IncompleteRead(payload, remaining)
            except Exception as error:
                payload = (error.partial[:65536] if isinstance(error, http.client.IncompleteRead)
                           and isinstance(error.partial, bytes) else b"")
                challenge = re.search(
                    rb"/cdn-cgi/challenge-platform/|_cf_chl_opt|enable javascript and cookies to continue",
                    payload, re.IGNORECASE)
                if response.status not in (401, 403) and not challenge:
                    raise
            # Withhold ordinary error headers until the bounded body is known
            # complete: streamSSE preserves a received HTTP status on EOF.
            emit(header_record)
            emit({"type": "error-body", "body": base64.b64encode(payload).decode("ascii")})
            return
        emit(header_record)
        while True:
            chunk = response.read1(16384)
            if not chunk:
                remaining = getattr(response, "length", None)
                if type(remaining) is int and remaining > 0:
                    raise http.client.IncompleteRead(b"", remaining)
                return
            emit({"type": "chunk", "body": base64.b64encode(chunk).decode("ascii")})


try:
    main()
except (Exception, KeyboardInterrupt):
    # Exception text may contain a signed URL or credential. Never return it.
    emit({"type": "error", "code": "NETWORK_ERROR"})
    sys.exit(1)
