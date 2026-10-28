FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && useradd --create-home --uid 10001 mcp
COPY valyu-mcp.py .

USER mcp
CMD ["python", "valyu-mcp.py"]
