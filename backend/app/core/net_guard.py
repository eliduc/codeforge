"""КАО#R5-ssrf — shared SSRF guard for outbound URLs (webhooks, etc.).

Resolves a URL's hostname and rejects private / loopback / reserved /
link-local / multicast addresses and known cloud-metadata hosts, so an
authenticated user cannot point an outbound request at the internal network
or the cloud metadata endpoint (blind SSRF).

Mirrors the long-standing clone-URL guard in ``repo_service._validate_clone_url``
but is scheme-configurable so it can protect http(s) webhooks as well as git
clone URLs. Kept dependency-free (only stdlib) so it can be imported from both
``app.schemas`` (request validation) and ``app.services`` (dispatch time)
without creating an import cycle.
"""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

# Hostnames that must never be reachable even before DNS resolution.
_BLOCKED_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "metadata",
    "metadata.google.internal",
}


def _is_internal(ip: ipaddress._BaseAddress) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_reserved
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
    )


def assert_public_url(
    url: str,
    *,
    allowed_schemes: tuple[str, ...] = ("http", "https"),
) -> None:
    """Raise ``ValueError`` if *url* is not safe to fetch from the server.

    Rejects unsupported schemes, missing hostnames, blocked metadata/loopback
    hosts, and any hostname that resolves to a private/internal IP (incl.
    IPv4-mapped IPv6 addresses like ``::ffff:169.254.169.254``).
    """
    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    if scheme not in allowed_schemes:
        raise ValueError(
            f"Unsupported URL scheme: {parsed.scheme!r}. "
            f"Allowed: {', '.join(allowed_schemes)}."
        )

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL has no hostname")

    if hostname.lower() in _BLOCKED_HOSTS:
        raise ValueError(f"URL targets a blocked host: {hostname}")

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise ValueError(f"Cannot resolve hostname: {hostname}")

    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr)
        if _is_internal(ip):
            raise ValueError(f"URL resolves to a private/internal address: {addr}")
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None and _is_internal(mapped):
            raise ValueError(f"URL resolves to a private/internal address: {addr}")
