"""
Generate a formatted PDF document from structured content.

The agent calls this tool to create downloadable PDF reports, summaries,
lesson plans, or any formatted document. The PDF is stored in MinIO and
a presigned download URL is returned.

Uses reportlab for PDF generation (lightweight, no external dependencies).
"""
import os
import io
import json
import uuid
import datetime
import urllib.request


def generate_pdf(
    title: str,
    content: str,
    filename: str = "",
) -> str:
    """Generate a PDF document and return a download URL.

    Args:
        title: Document title (appears as header on first page).
        content: Document body in plain text or simple markdown.
                 Supports: paragraphs (blank line separated),
                 headers (lines starting with # or ##),
                 bullet points (lines starting with - or *).
        filename: Optional filename (without .pdf extension).
                  Defaults to a slugified version of the title.

    Returns:
        JSON string with {url, filename, pages} on success,
        or {error} on failure.
    """
    if not title or not content:
        return json.dumps({"error": "title and content are required"})

    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        from reportlab.lib.enums import TA_LEFT
    except ImportError:
        return json.dumps({"error": "reportlab not installed — PDF generation unavailable"})

    # Generate PDF in memory
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
    )

    styles = getSampleStyleSheet()
    title_style = styles["Title"]
    heading_style = ParagraphStyle(
        "CustomHeading",
        parent=styles["Heading2"],
        spaceAfter=6,
        spaceBefore=12,
    )
    body_style = ParagraphStyle(
        "CustomBody",
        parent=styles["Normal"],
        fontSize=11,
        leading=15,
        spaceAfter=8,
    )
    bullet_style = ParagraphStyle(
        "CustomBullet",
        parent=body_style,
        leftIndent=20,
        bulletIndent=10,
        spaceBefore=2,
        spaceAfter=2,
    )

    elements = []
    elements.append(Paragraph(title, title_style))
    elements.append(Spacer(1, 12))

    # Parse content into paragraphs
    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped:
            elements.append(Spacer(1, 6))
        elif stripped.startswith("## "):
            elements.append(Paragraph(stripped[3:], heading_style))
        elif stripped.startswith("# "):
            elements.append(Paragraph(stripped[2:], heading_style))
        elif stripped.startswith("- ") or stripped.startswith("* "):
            elements.append(Paragraph(f"• {stripped[2:]}", bullet_style))
        else:
            # Escape HTML special chars for reportlab
            safe = stripped.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            elements.append(Paragraph(safe, body_style))

    # Add footer with generation date
    elements.append(Spacer(1, 24))
    footer_style = ParagraphStyle("Footer", parent=body_style, fontSize=8, textColor="grey")
    elements.append(Paragraph(
        f"Generated on {datetime.datetime.now().strftime('%B %d, %Y at %H:%M')}",
        footer_style,
    ))

    doc.build(elements)
    pdf_bytes = buffer.getvalue()
    buffer.close()

    # Upload to MinIO
    safe_filename = filename or title.lower().replace(" ", "-")[:50]
    safe_filename = "".join(c for c in safe_filename if c.isalnum() or c in "-_")
    object_key = f"documents/pdf/{safe_filename}-{uuid.uuid4().hex[:8]}.pdf"

    minio_endpoint = os.environ.get("MINIO_ENDPOINT", "minio-tenant-hl.minio.svc.cluster.local:9000")
    minio_bucket = os.environ.get("MINIO_BUCKET", "")
    minio_access = os.environ.get("MINIO_ACCESS_KEY", "")
    minio_secret = os.environ.get("MINIO_SECRET_KEY", "")

    if not minio_bucket or not minio_access:
        return json.dumps({"error": "MinIO not configured for this agent"})

    try:
        from minio import Minio

        client = Minio(
            minio_endpoint,
            access_key=minio_access,
            secret_key=minio_secret,
            secure=False,
        )
        client.put_object(
            minio_bucket,
            object_key,
            io.BytesIO(pdf_bytes),
            len(pdf_bytes),
            content_type="application/pdf",
        )
        # Generate presigned URL (24h)
        url = client.presigned_get_object(minio_bucket, object_key, expires=datetime.timedelta(hours=24))

        page_count = pdf_bytes.count(b"/Type /Page") or 1

        return json.dumps({
            "url": url,
            "filename": f"{safe_filename}.pdf",
            "pages": page_count,
            "size_bytes": len(pdf_bytes),
            "minio_path": f"s3://{minio_bucket}/{object_key}",
        })
    except Exception as e:
        return json.dumps({"error": f"MinIO upload failed: {str(e)}"})
