"""Email service for sending OTP codes via SMTP."""

import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape as html_escape

import aiosmtplib

from app.config import get_settings

logger = logging.getLogger(__name__)


def _smtp_kwargs() -> dict:
    """Build keyword arguments for aiosmtplib.send() from settings.

    Port 465 → direct TLS (use_tls=True)
    Port 587 → STARTTLS  (start_tls=True)
    """
    settings = get_settings()
    kwargs: dict = {
        "hostname": settings.smtp_host,
        "port": settings.smtp_port,
        "username": settings.smtp_user,
        "password": (
            settings.smtp_password.get_secret_value()
            if settings.smtp_password
            else None
        ),
    }
    if settings.smtp_port == 465:
        kwargs["use_tls"] = True
    else:
        kwargs["start_tls"] = True
    return kwargs


async def send_otp_email(to_email: str, otp_code: str) -> None:
    """Send a one-time password to the given email address.

    When SMTP is not configured (smtp_host is None), the OTP is logged
    to the console — useful for local development without a mail server.
    """
    settings = get_settings()

    if settings.smtp_host is None:
        logger.warning(
            "[DEV MODE] OTP for %s: %s  (SMTP not configured — set SMTP_HOST to send real emails)",
            to_email,
            otp_code,
        )
        return

    subject = "Your CodeForge login code"
    html_body = f"""\
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             background-color: #0f172a; color: #e2e8f0; padding: 40px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1e293b;
              border-radius: 12px; padding: 32px; text-align: center;">
    <h2 style="color: #818cf8; margin-bottom: 8px;">CodeForge</h2>
    <p style="color: #94a3b8; margin-bottom: 24px;">Your one-time login code</p>
    <div style="font-size: 36px; font-weight: 700; letter-spacing: 0.3em;
                color: #f1f5f9; background: #334155; border-radius: 8px;
                padding: 16px 24px; display: inline-block;">
      {otp_code}
    </div>
    <p style="color: #64748b; margin-top: 24px; font-size: 13px;">
      This code expires in {settings.otp_expiry_minutes} minutes.<br>
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>
</body>
</html>"""

    msg = MIMEMultipart("alternative")
    msg["From"] = f"CodeForge <{settings.smtp_from_email}>"
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(f"Your CodeForge login code: {otp_code}", "plain"))
    msg.attach(MIMEText(html_body, "html"))

    try:
        await aiosmtplib.send(msg, **_smtp_kwargs())
        logger.info("OTP email sent to %s", to_email)
    except Exception:
        logger.exception("Failed to send OTP email to %s", to_email)
        raise


async def send_access_request_email(requester_email: str, admin_email: str) -> None:
    """Send an access request notification to the administrator.

    When SMTP is not configured, the request is logged to the console.
    """
    settings = get_settings()

    if settings.smtp_host is None:
        logger.warning(
            "[DEV MODE] Access request from %s → admin %s  (SMTP not configured)",
            requester_email,
            admin_email,
        )
        return

    subject = "CodeForge — Access Request"
    html_body = f"""\
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             background-color: #0f172a; color: #e2e8f0; padding: 40px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1e293b;
              border-radius: 12px; padding: 32px;">
    <h2 style="color: #818cf8; margin-bottom: 16px;">CodeForge — Access Request</h2>
    <p style="color: #e2e8f0; margin-bottom: 8px;">
      User <strong style="color: #f1f5f9;">{html_escape(requester_email)}</strong> is requesting
      access to CodeForge.
    </p>
    <p style="color: #94a3b8; font-size: 14px; margin-top: 16px;">
      To grant access, add this email to the <code>ALLOWED_EMAILS</code>
      environment variable and restart the application.
    </p>
  </div>
</body>
</html>"""

    msg = MIMEMultipart("alternative")
    msg["From"] = f"CodeForge <{settings.smtp_from_email}>"
    msg["To"] = admin_email
    msg["Subject"] = subject
    msg["Reply-To"] = requester_email
    msg.attach(MIMEText(
        f"Access request from {requester_email} — add to ALLOWED_EMAILS to grant access.",
        "plain",
    ))
    msg.attach(MIMEText(html_body, "html"))

    try:
        await aiosmtplib.send(msg, **_smtp_kwargs())
        logger.info("Access request email sent to admin %s (from %s)", admin_email, requester_email)
    except Exception:
        logger.exception("Failed to send access request email to %s", admin_email)
        raise
