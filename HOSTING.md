# Hosting the SHERPA voice connector on AWS

This describes how to host the SHERPA voice connector in this repo as a container on AWS ECS. It is written for whoever does the infrastructure side, so you don't need to read the code.

## What gets deployed

- **A container image** built from `Dockerfile.sherpa`. It runs the voice service on port 8791.
- It runs as a **sidecar in the host application's ECS task**, not as a public service. It listens only inside the task (`127.0.0.1:8791`), with no load balancer or public port. The host application passes authenticated requests to it.
- **A separate HTTPS page** serves the voice avatar to the browser: `/sherpa.html`, `/sherpa-config.js` and the files built into `dist-sherpa`. Browsers only allow the microphone on HTTPS, so this must be an HTTPS address.

## Steps

1. **Build the image:** `docker build -f Dockerfile.sherpa -t mood-voice-sherpa .`, push it to your registry and note the image digest (`sha256:...`). Reference the digest, not a tag.
2. **Add the usage hook to the image (optional for local use, required when hosted).** The comment in `Dockerfile.sherpa` lists the files. It records OpenAI usage for cost tracking and comes from the host application, not this repo. Without it the service reports `ready: false` in hosted mode, on purpose.
3. **Create two secrets in SSM Parameter Store** as SecureString, in the same account and region as the task:
   - the OpenAI API key;
   - a bridge token: a new random value of 32+ characters. Don't reuse the OpenAI key.
   Pass only their ARNs to your infrastructure code. Never put the values in source control, logs or chat.
4. **Set these environment variables on the sidecar:**
   - `SHERPA_VOICE_HOSTED=1`
   - `SHERPA_VOICE_PARENT_ORIGINS`: comma-separated HTTPS origins that may embed the avatar page
   - `SHERPA_VOICE_BRIDGE_TOKEN`: from SSM
   - `OPENAI_API_KEY`: from SSM
   - `SHERPA_VOICE_USAGE_MODULE`: file URL of the usage hook, if you added it
   - `OPENAI_REALTIME_MODEL`: optional model override
5. **Host the avatar page** (`dist-sherpa`, `/sherpa.html`, `/sherpa-config.js`) at an HTTPS address that the host application is allowed to embed.
6. **Give the host application** the matching settings so it can reach the sidecar: the runtime URL, the service origin and the same bridge token.
7. **Check:** the connector's `/healthz` returns `ready: true`, then open the host app over HTTPS, start voice and allow the microphone.

## Things to know

- **Licensing:** `@bible-strong/avatar-core`, which this project uses, is licensed AGPL-3.0-only. Review its terms before deploying it anywhere.
- **Secrets stay out of the image.** The key and bridge token are runtime inputs only.
- Try it on a test environment first, not production.
