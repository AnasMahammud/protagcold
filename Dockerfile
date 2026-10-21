# PRO TAG server image: serves the game AND the multiplayer endpoint on $PORT.
# Works on Render, Railway, Fly.io, Koyeb, Google Cloud Run, or any Docker host.
#   docker build -t pro-tag .
#   docker run -p 8080:8080 pro-tag          -> http://localhost:8080
FROM python:3.12-slim
WORKDIR /app
# standard library only: nothing to pip install
COPY index.html ./
COPY config ./config
COPY src ./src
COPY vendor ./vendor
COPY assets ./assets
COPY server ./server
ENV PORT=8080 PROTAG_HOST=0.0.0.0 PYTHONUNBUFFERED=1
EXPOSE 8080
RUN useradd --create-home protag
USER protag
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ['PORT']+'/healthz')"
CMD ["python", "server/main.py"]
