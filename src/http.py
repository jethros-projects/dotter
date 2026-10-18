"""One ordinary HTTPS request using Python's standard-library client.

Request data arrives on a private stdin pipe, never command-line arguments.
Only the response envelope is written to stdout. No cookie jar, browser
impersonation, challenge solver, retries, or credential storage is involved.
"""
import base64
import hashlib
import http.client
import json
import math
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BODY = 10 * 1024 * 1024
MAX_UPLOAD_FILE = 512 * 1024 * 1024
UPLOAD_READ_SIZE = 1024 * 1024


class UploadFileError(Exception):
    def __init__(self, code, delivery="not_sent"):
        self.code = code
        self.delivery = delivery


class UploadFileBody:
    """Verified, length-delimited file body; never buffer the whole file."""

    def __init__(self, source, prefix=b"", suffix=b""):
        self.fd = None
        self.started = False
        self.prefix, self.suffix = prefix, suffix
        self.prefix_offset = self.suffix_offset = 0
        self.source = source
        self.identity = None
        self.digest = hashlib.sha256()
        try:
            if not isinstance(source, dict):
                raise ValueError("invalid source")
            path = source.get("path")
            if (not isinstance(path, str) or not os.path.isabs(path)
                    or os.path.normpath(path) != path or len(path) > 8192
                    or any(character in path for character in "\0\r\n")
                    or os.path.realpath(os.path.dirname(path)) != os.path.dirname(path)):
                raise ValueError("invalid path")
            for field in ("sizeBytes", "offset", "length"):
                if type(source.get(field)) is not int:
                    raise ValueError("invalid size")
            if (not 1 <= source["sizeBytes"] <= MAX_UPLOAD_FILE or source["offset"] < 0
                    or source["length"] < 1 or source["offset"] + source["length"] > source["sizeBytes"]
                    or not isinstance(source.get("sha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", source["sha256"])):
                raise ValueError("invalid range")
            for field in ("dev", "ino"):
                if not isinstance(source.get(field), str) or not re.fullmatch(r"(?:0|[1-9]\d*)", source[field]):
                    raise ValueError("invalid identity")
            for field in ("mtimeMs", "ctimeMs"):
                if type(source.get(field)) not in (int, float) or not math.isfinite(source[field]):
                    raise ValueError("invalid timestamp")
            self.fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            self.check_identity()
            # Validate exactly the requested range before its first network byte.
            # Source helpers bind the range digest to the original full-file hash.
            os.lseek(self.fd, source["offset"], os.SEEK_SET)
            remaining, digest = source["length"], hashlib.sha256()
            while remaining:
                chunk = os.read(self.fd, min(remaining, UPLOAD_READ_SIZE))
                if not chunk:
                    raise UploadFileError("FILE_CHANGED")
                digest.update(chunk)
                remaining -= len(chunk)
            self.check_identity()
            if digest.hexdigest() != source["sha256"]:
                raise UploadFileError("FILE_CHANGED")
            os.lseek(self.fd, source["offset"], os.SEEK_SET)
            self.remaining = source["length"]
            self.length = len(prefix) + source["length"] + len(suffix)
        except UploadFileError:
            self.close()
            raise
        except Exception:
            self.close()
            raise UploadFileError("INVALID_FILE") from None

    def check_identity(self):
        try:
            current = os.fstat(self.fd)
            named = os.stat(self.source["path"], follow_symlinks=False)
            identity = (current.st_dev, current.st_ino, current.st_size, current.st_mode,
                        current.st_mtime_ns, current.st_ctime_ns)
            if (not stat.S_ISREG(current.st_mode) or not stat.S_ISREG(named.st_mode)
                    or current.st_dev != int(self.source["dev"]) or current.st_ino != int(self.source["ino"])
                    or current.st_size != self.source["sizeBytes"]
                    or named.st_dev != current.st_dev or named.st_ino != current.st_ino
                    # Node's millisecond timestamp can round by one microsecond
                    # when converted through a JSON number. Range hashes remain
                    # exact and are checked before and during transmission.
                    or abs(current.st_mtime_ns / 1000 - self.source["mtimeMs"] * 1000) > 1
                    or abs(current.st_ctime_ns / 1000 - self.source["ctimeMs"] * 1000) > 1
                    or self.identity is not None and self.identity != identity):
                raise ValueError("changed")
            self.identity = identity
        except Exception:
            raise UploadFileError("FILE_CHANGED", "unknown" if self.started else "not_sent") from None

    def read(self, size=-1):
        # http.client passes its block size; honor it without allowing callers
        # or transports to turn this method into an unbounded allocation.
        size = UPLOAD_READ_SIZE if size is None or size < 0 else min(size, UPLOAD_READ_SIZE)
        if not size:
            return b""
        self.check_identity()
        if self.prefix_offset < len(self.prefix):
            result = self.prefix[self.prefix_offset:self.prefix_offset + size]
            self.prefix_offset += len(result)
            return result
        if self.remaining:
            result = os.read(self.fd, min(size, self.remaining))
            if not result:
                raise UploadFileError("FILE_CHANGED", "unknown" if self.started else "not_sent")
            self.remaining -= len(result)
            self.digest.update(result)
            self.check_identity()
            if not self.remaining and self.digest.hexdigest() != self.source["sha256"]:
                raise UploadFileError("FILE_CHANGED", "unknown" if self.started else "not_sent")
            return result
        if self.suffix_offset < len(self.suffix):
            result = self.suffix[self.suffix_offset:self.suffix_offset + size]
            self.suffix_offset += len(result)
            return result
        return b""

    def finish(self):
        self.check_identity()
        if (self.remaining or self.prefix_offset != len(self.prefix)
                or self.suffix_offset != len(self.suffix)
                or self.digest.hexdigest() != self.source["sha256"]):
            raise UploadFileError("FILE_CHANGED", "unknown" if self.started else "not_sent")

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def main():
    request = json.load(sys.stdin)
    maximum = request.get("maxBytes", MAX_BODY)
    if type(maximum) is not int or not 1 <= maximum <= 100 * 1024 * 1024:
        raise ValueError("invalid response limit")
    timeout_ms = request.get("timeoutMs", 30000)
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 600000:
        raise ValueError("invalid request timeout")
    if sum(request.get(field) is not None for field in ("body", "bodyBase64", "bodyFile")) > 1:
        raise ValueError("duplicate body")
    url = urllib.parse.urlsplit(request["url"])
    regional_file = re.fullmatch(r"sdmntpr[a-z0-9-]+\.oaiusercontent\.com", url.netloc) and any(key == "sig" and value for key, value in urllib.parse.parse_qsl(url.query))
    signed_file = request.get("signedFile") is True and (url.netloc == "files.oaiusercontent.com" or regional_file)
    storage_host = url.netloc == "files.oaiusercontent.com" or re.fullmatch(r"sdmntpr[a-z0-9-]+\.oaiusercontent\.com", url.netloc) or re.fullmatch(r"[a-z0-9-]+\.blob\.core\.windows\.net", url.netloc) or re.fullmatch(r"(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com", url.netloc)
    signed_upload = request.get("signedUpload") is True and storage_host and any(key.lower() in ("sig", "x-amz-signature", "signature") and value for key, value in urllib.parse.parse_qsl(url.query))
    realtime = request.get("realtimeSdp") is True and url.netloc == "realtime.chatgpt.com" and url.path == "/v1/cua"
    if (url.scheme != "https" or (url.netloc != "chatgpt.com" and not signed_file and not signed_upload and not realtime)
            or (not signed_file and not signed_upload and not realtime and not url.path.startswith("/backend-api/"))
            or url.username or url.password or url.fragment):
        raise ValueError("invalid origin")
    if request["method"] not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        raise ValueError("invalid method")
    if signed_file and (request["method"] != "GET" or any(k.lower() in ("authorization", "cookie", "chatgpt-account-id") for k in request["headers"])):
        raise ValueError("credentials forbidden for signed files")
    if signed_upload and (request["method"] != "PUT" or any(k.lower() in ("authorization", "cookie", "chatgpt-account-id") for k in request["headers"])):
        raise ValueError("credentials forbidden for signed uploads")
    multipart_kind = request.get("azureMultipart")
    if multipart_kind is not None:
        pairs = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
        fields = dict(pairs)
        lower_headers = {key.lower(): value for key, value in request["headers"].items()}
        azure_host = (re.fullmatch(r"[a-z0-9-]+\.blob\.core\.windows\.net", url.netloc)
                      or re.fullmatch(r"sdmntpr[a-z0-9-]+\.oaiusercontent\.com", url.netloc))
        allowed_headers = {"content-type", "x-ms-version"} | ({"x-ms-blob-content-type"} if multipart_kind == "blocklist" else set())
        if (not signed_upload or not azure_host or not fields.get("sig")
                or multipart_kind not in ("block", "blocklist") or fields.get("comp") != multipart_kind
                or sum(key == "comp" for key, _ in pairs) != 1
                or any(key not in allowed_headers for key in lower_headers)
                or lower_headers.get("x-ms-version") != "2020-04-08"
                or not re.fullmatch(r"[\w.+-]+/[\w.+-]+", lower_headers.get("content-type", ""))):
            raise ValueError("invalid azure multipart request")
        if multipart_kind == "block":
            encoded = fields.get("blockid", "")
            decoded = base64.b64decode(encoded, validate=True)
            if (sum(key == "blockid" for key, _ in pairs) != 1
                    or not re.fullmatch(rb"\d{8}", decoded)
                    or base64.b64encode(decoded).decode("ascii") != encoded):
                raise ValueError("invalid block ID")
        elif ("blockid" in fields or lower_headers.get("content-type") != "application/xml"
              or "x-ms-blob-content-type" in lower_headers and not re.fullmatch(r"[\w.+-]+/[\w.+-]+", lower_headers["x-ms-blob-content-type"])):
            raise ValueError("invalid block commit")
    if realtime and (request["method"] != "POST" or request["headers"].get("Content-Type") != "application/sdp"):
        raise ValueError("invalid realtime negotiation")
    if realtime:
        pairs = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
        fields = dict(pairs)
        expected = {"source", "thread_id", "aeon_id"} if fields.get("source") == "aeon" else {"source", "cid"} if fields.get("source") == "flora" else set()
        if not expected or set(fields) != expected or len(pairs) != len(expected) or any(
                not re.fullmatch(r"[A-Za-z0-9_.~:-]{1,1024}", value) or value in (".", "..")
                for key, value in pairs):
            raise ValueError("invalid realtime target")
    body = request.get("body")
    data = None if body is None else body.encode("utf-8")
    if request.get("bodyBase64") is not None:
        data = base64.b64decode(request["bodyBase64"], validate=True)
    file_data = None
    try:
        if request.get("bodyFile") is not None:
            if any(key.lower() in ("content-length", "transfer-encoding") for key in request["headers"]):
                raise ValueError("caller cannot override file framing")
            source = request["bodyFile"]
            prefix, suffix = b"", b""
            if not signed_upload:
                # Only the native authenticated Estuary upload accepts a file body.
                # Construct its multipart wrapper here rather than accepting an
                # arbitrary authenticated streaming route or caller-supplied bytes.
                pairs = urllib.parse.parse_qsl(url.query, keep_blank_values=True)
                metadata = source.get("multipart") if isinstance(source, dict) else None
                if (url.netloc != "chatgpt.com" or url.path != "/backend-api/estuary/upload_content_bytes"
                        or request["method"] != "POST" or not isinstance(metadata, dict)
                        or request["headers"].get("X-OpenAI-Attach-Auth") != "1"
                        or pairs != [("upload_url", metadata.get("uploadUrl"))]):
                    raise ValueError("invalid streaming upload")
                boundary, name, mime = metadata.get("boundary"), metadata.get("name"), metadata.get("mimeType")
                if (not isinstance(boundary, str) or not re.fullmatch(r"dot-library-[a-f0-9-]{36}", boundary)
                        or not isinstance(name, str) or not 1 <= len(name) <= 240
                        or re.search(r"[\x00-\x1f\x7f/\\]", name)
                        or not isinstance(mime, str) or not re.fullmatch(r"[\w.+-]+/[\w.+-]+", mime)
                        or request["headers"].get("Content-Type") != "multipart/form-data; boundary=" + boundary):
                    raise ValueError("invalid multipart fields")
                # The upstream URL remains form data; this process never follows it.
                upstream = metadata.get("uploadUrl")
                if not isinstance(upstream, str) or len(upstream) > 16384 or re.search(r"[\x00-\x20\x7f]", upstream):
                    raise ValueError("invalid upstream")
                upstream_url = urllib.parse.urlsplit(upstream)
                upstream_host = (upstream_url.netloc == "files.oaiusercontent.com"
                                 or re.fullmatch(r"sdmntpr[a-z0-9-]+\.oaiusercontent\.com", upstream_url.netloc)
                                 or re.fullmatch(r"[a-z0-9-]+\.blob\.core\.windows\.net", upstream_url.netloc)
                                 or re.fullmatch(r"(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com", upstream_url.netloc))
                if (upstream_url.scheme != "https" or not upstream_host or upstream_url.fragment
                        or not any(key.lower() in ("sig", "x-amz-signature", "signature") and value
                                   for key, value in urllib.parse.parse_qsl(upstream_url.query))):
                    raise ValueError("invalid upstream")
                name = name.replace('"', '%22')
                prefix = ("--" + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name
                          + '"\r\nContent-Type: ' + mime + '\r\n\r\n').encode("utf-8")
                suffix = ("\r\n--" + boundary + '\r\nContent-Disposition: form-data; name="upload_url"\r\n\r\n'
                          + upstream + "\r\n--" + boundary + "--\r\n").encode("utf-8")
            if multipart_kind == "blocklist":
                raise ValueError("block commits require XML")
            file_data = UploadFileBody(source, prefix, suffix)
            data = file_data
            request["headers"]["Content-Length"] = str(file_data.length)
        if multipart_kind == "blocklist":
            if not isinstance(data, bytes) or len(data) > 2 * 1024 * 1024:
                raise ValueError("invalid block XML")
            lines = data.decode("ascii").split("\n")
            if (len(lines) < 5 or len(lines) > 50003 or lines[:2] != ['<?xml version="1.0" encoding="utf-8"?>', '<BlockList>']
                    or lines[-1] != '</BlockList>'):
                raise ValueError("invalid block XML")
            for index, line in enumerate(lines[2:-1]):
                encoded = base64.b64encode(str(index).zfill(8).encode("ascii")).decode("ascii")
                if line != '  <Latest>' + encoded + '</Latest>':
                    raise ValueError("invalid ordered block list")
        req = urllib.request.Request(request["url"], data=data,
                                     headers=request["headers"],
                                     method=request["method"])
        try:
            if file_data is not None:
                file_data.started = True
            response = urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout_ms / 1000)
        except urllib.error.HTTPError as error:
            response = error
        except urllib.error.URLError as error:
            if isinstance(error.reason, UploadFileError):
                raise error.reason
            raise
        with response:
            if file_data is not None:
                file_data.finish()
            allowed = ("content-type", "content-disposition", "cf-mitigated", "cf-ray", "retry-after",
                       "x-request-id", "x-openai-request-id", "location", "openai-root-thread-id",
                       "content-length", "content-range", "accept-ranges", "content-encoding")
            # Preserve a definitive challenge even when its body is broken or
            # never finishes; the caller classifies the filtered envelope.
            if response.headers.get("cf-mitigated") == "challenge":
                payload = b""
            else:
                try:
                    # http.client accepts ambiguous/malformed lengths as either
                    # the first value or an EOF-delimited body. Neither can
                    # establish complete success or definitive absence.
                    lengths = response.headers.get_all("content-length", [])
                    if (len(lengths) > 1 or lengths and
                            (not re.fullmatch(r"[0-9]+", lengths[0].strip())
                             or response.headers.get_all("transfer-encoding", []))):
                        raise ValueError("ambiguous response framing")
                    if lengths:
                        # Also reject values too large for Python's parser;
                        # http.client otherwise silently treats them as absent.
                        int(lengths[0].strip())
                    payload = response.read(maximum + 1)
                    # read(amt) can return an incomplete fixed-length body
                    # without raising. Success and absence responses must be complete.
                    remaining = getattr(response, "length", None)
                    if ((200 <= response.code < 300 or response.code in (404, 410)) and len(payload) <= maximum
                            and type(remaining) is int and remaining > 0):
                        raise http.client.IncompleteRead(payload, remaining)
                except Exception as error:
                    # Keep known auth refusals and confirmed body challenges.
                    # Other incomplete absence responses remain indeterminate.
                    payload = (error.partial[:maximum] if isinstance(error, http.client.IncompleteRead)
                               and isinstance(error.partial, bytes) else b"")
                    absence_challenge = response.code in (404, 410) and re.search(
                        rb"/cdn-cgi/challenge-platform/|_cf_chl_opt|enable javascript and cookies to continue",
                        payload, re.IGNORECASE)
                    if response.code not in (401, 403) and not absence_challenge:
                        raise
            if len(payload) > maximum:
                print(json.dumps({"error": "RESPONSE_TOO_LARGE"}))
                return
            print(json.dumps({
                "status": response.code,
                "headers": {key: (", ".join(response.headers.get_all(key)) if key == "content-encoding"
                                  else response.headers[key]) for key in allowed if key in response.headers},
                "body": base64.b64encode(payload).decode("ascii"),
            }))
    finally:
        if file_data is not None:
            file_data.close()


if __name__ == "__main__":
    try:
        main()
    except UploadFileError as error:
        print(json.dumps({"error": error.code, "delivery": error.delivery}))
    except Exception:
        # Never serialize exceptions: they may contain request data.
        print(json.dumps({"error": "NETWORK_ERROR"}))
