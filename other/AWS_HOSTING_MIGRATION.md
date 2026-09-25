# Moving the App Itself (Hosting) from Render to AWS

This covers moving **compute** - where `py/server.py` actually runs - from
Render to AWS. For moving the **database**, see `AWS_MIGRATION.md`; the
two are independent and can be done separately or together.

## Why this is a relatively easy move

The app is already packaged as a Dockerfile (see `Dockerfile`), built
specifically because the OCR fallback needs the `tesseract-ocr` system
package - which means it's not tied to Render's Python buildpack at all.
Any platform that runs a Docker container works, AWS included, with no
code changes.

## The one thing to solve first: file storage

Render's `render.yaml` mounts a persistent disk at `/var/lexora-data`
(`LEXORA_DATA_DIR`) so uploaded files, profile photos, lease templates,
and staged documents survive across deploys. AWS has two ways to get the
same guarantee - pick based on how much you want to modernize at the same
time:

### Option A - Lift-and-shift (fastest, closest to today's setup)
Run on **ECS Fargate** with an **EFS** volume mounted at the same path
(`/var/lexora-data`), and set `LEXORA_DATA_DIR` to that path exactly like
Render does today. Nothing in `py/server.py` needs to change - EFS
behaves like a normal mounted disk. This is the quickest path to parity.

### Option B - Recommended modernization: move file storage to S3
Instead of a mounted disk, store uploaded/processed files in an S3
bucket. This decouples storage from compute entirely, which means:
- Any AWS compute option works (including ones that can't mount a
  volume, like App Runner or Lambda) - not just Fargate.
- Storage scales independently and is durable by default (11 nines).
- It also sets up the SharePoint/Dropbox/ShareFile delivery feature
  described in `EXTERNAL_STORAGE_INTEGRATION.md` well, since "write
  finished file to S3, then optionally also push to the client's own
  storage" becomes one consistent code path instead of two.

  This does require replacing the handful of places in `py/server.py`
  that currently do `open(path, "wb")`/`open(path, "rb")` under
  `Users/<userId>/...` with S3 `put_object`/`get_object` calls (`boto3`).
  Not a huge change - it's a well-contained set of file I/O helper
  functions - but it's real code work, not just a config change like
  Option A is.

**Suggestion:** do Option A first to get off Render quickly with zero
code risk, then move to Option B on your own timeline once you're
settled on AWS.

## Compute options, compared

| Option | Effort | Notes |
|---|---|---|
| **AWS App Runner** | Lowest | Closest to Render's experience - point it at an image in ECR, it handles scaling/HTTPS/deploys. Cannot mount EFS directly, so only works cleanly with Option B (S3) for file storage. |
| **ECS on Fargate** | Medium | No servers to manage, supports EFS mounts (Option A works here), more configuration than App Runner (task definitions, service, load balancer). |
| **EC2 + Docker** | Highest | Full control, cheapest at small/steady scale, you manage OS patching/scaling yourself. Closest to "just run the container on a box," works with either storage option (EFS or a plain EBS volume). |

For a small-to-medium SaaS like this, **App Runner + S3** or
**ECS Fargate + EFS** are both reasonable starting points; App Runner is
simpler to operate, ECS gives more room to grow into (custom networking,
multiple services, etc.) later.

## Step-by-step (ECS Fargate + EFS path, since it needs no code changes)

1. **Push the image to ECR.**
   ```bash
   aws ecr create-repository --repository-name lexora
   docker build -t lexora .
   docker tag lexora:latest <account-id>.dkr.ecr.<region>.amazonaws.com/lexora:latest
   aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
   docker push <account-id>.dkr.ecr.<region>.amazonaws.com/lexora:latest
   ```

2. **Create an EFS file system** in the same VPC the ECS service will
   run in, and note its access point ID.

3. **Create an ECS task definition** (Fargate launch type):
   - Container image: the ECR image above.
   - Port mapping: 8000 (same as `EXPOSE 8000` in the Dockerfile).
   - Volume: mount the EFS access point at `/var/lexora-data`.
   - Environment variables: copy every `envVars` entry from
     `render.yaml` into the task definition - same names, same values
     (`LEXORA_DATA_DIR=/var/lexora-data`, `LLM_PROVIDER`,
     `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `SMTP_*`, plus
     `DATABASE_URL` if you've also migrated the DB per
     `AWS_MIGRATION.md`, and `TWILIO_*`/`RAZORPAY_*` per whatever's set
     on Render today).

4. **Create an ECS service** (Fargate) using that task definition, behind
   an **Application Load Balancer** for HTTPS termination.

5. **Point DNS** (Route 53, or your existing registrar) at the load
   balancer, and request an ACM certificate for HTTPS.

6. **Verify** the same way suggested in `AWS_MIGRATION.md`'s cutover
   section - check Profile > Overview and Admin > Database, upload a
   test file through one service, confirm it persists after a redeploy.

7. **Decommission Render** once you've run on AWS long enough to be
   confident (a few days to a week of normal traffic is reasonable).

## What doesn't need to change either way

- The Dockerfile itself - identical on Render or AWS.
- Every environment variable name - only the *values* and *where you set
  them* change (Render's dashboard vs. ECS task definition / App Runner
  config / EC2's env file).
- `py/server.py`'s `PORT` handling - it already reads `os.environ.get("PORT", 8000)`,
  which works the same way on AWS.
- The database migration - entirely separate, see `AWS_MIGRATION.md`.
