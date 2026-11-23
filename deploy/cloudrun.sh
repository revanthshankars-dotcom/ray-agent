#!/usr/bin/env bash
# Deploy RAY to Google Cloud Run so it is ALWAYS on (min-instances=1) and wakes on "Hey Ray"
# from any device. State (Second Brain, devices, queued commands) lives in a GCS bucket.
#
# Usage:  PROJECT_ID=my-project REGION=asia-south1 ./deploy/cloudrun.sh
set -euo pipefail
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ray-hub}"
BUCKET="${RAY_GCS_BUCKET:-${PROJECT_ID}-ray-brain}"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com storage.googleapis.com secretmanager.googleapis.com

# 1) Durable storage bucket for the Second Brain + room state
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access

# 2) Secrets (created once; edit values in Secret Manager afterwards)
create_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=-
  fi
}
create_secret RELAY_MASTER_SECRET "$(openssl rand -hex 32)"
for s in GEMINI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY CEREBRAS_API_KEY MISTRAL_API_KEY GITHUB_MODELS_TOKEN NVIDIA_API_KEY HUGGINGFACE_API_KEY; do
  create_secret "$s" "unset"
done

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null

# 3) Build + deploy. min-instances=1 keeps RAY awake 24/7; session affinity keeps WebSockets sticky.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --timeout 3600 \
  --session-affinity \
  --cpu-boost --no-cpu-throttling \
  --memory 1Gi \
  --set-env-vars "RAY_GCS_BUCKET=$BUCKET,NODE_ENV=production" \
  --set-secrets "RELAY_MASTER_SECRET=RELAY_MASTER_SECRET:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,GROQ_API_KEY=GROQ_API_KEY:latest,OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,CEREBRAS_API_KEY=CEREBRAS_API_KEY:latest,MISTRAL_API_KEY=MISTRAL_API_KEY:latest,GITHUB_MODELS_TOKEN=GITHUB_MODELS_TOKEN:latest,NVIDIA_API_KEY=NVIDIA_API_KEY:latest,HUGGINGFACE_API_KEY=HUGGINGFACE_API_KEY:latest"

echo
echo "RAY is live at: $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "Put real API keys in Secret Manager (any left as 'unset' are simply skipped by the engine router)."
