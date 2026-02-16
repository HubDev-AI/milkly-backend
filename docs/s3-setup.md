# S3 Storage Setup Guide

This guide covers setting up AWS S3 for media uploads in Milkly.

## Overview

The app uses S3 for:
- **User media gallery** → Private files with signed URLs (expire in 1 hour)
- **Published newsletters** → Public files with permanent URLs

## 1. Create an S3 Bucket

1. Go to [AWS S3 Console](https://s3.console.aws.amazon.com/s3/buckets)
2. Click **Create bucket**
3. Enter a bucket name (e.g., `milkly-media-prod`)
4. Select your region (e.g., `us-east-1`)
5. Keep "Block all public access" **checked** for now
6. Click **Create bucket**

## 2. Configure Block Public Access Settings

This allows the bucket policy to grant public access to the `public/` folder while keeping everything else private.

1. Select your bucket → **Permissions** tab
2. Under **Block public access (bucket settings)**, click **Edit**
3. Configure these settings:

| Setting | Status | Reason |
|---------|--------|--------|
| Block public access granted through **new ACLs** | ✅ ON | We use bucket policies, not ACLs |
| Block public access granted through **any ACLs** | ✅ ON | We use bucket policies, not ACLs |
| Block public access granted through **new public bucket or access point policies** | ❌ OFF | Allows our bucket policy to work |
| Block public and cross-account access through **any public bucket or access point policies** | ❌ OFF | Allows our bucket policy to work |

4. Save changes

## 3. Add Bucket Policy

1. Still in **Permissions** tab, scroll to **Bucket policy**
2. Click **Edit** and add this policy (replace `YOUR-BUCKET-NAME`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadForPublicFolder",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/public/*"
    }
  ]
}
```

### How Access Works

| Path | Access | Use Case |
|------|--------|----------|
| `users/{id}/media/*` | Private (signed URLs) | User's media gallery |
| `public/*` | Public (permanent URLs) | Published newsletter images |

## 4. Configure CORS

Required for browser-based uploads.

1. In your bucket → **Permissions** tab
2. Scroll to **CORS** and click **Edit**
3. Add this configuration:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

> **Production tip**: Replace `"AllowedOrigins": ["*"]` with your actual domains for better security.

## 5. Create IAM User for API Access

1. Go to [IAM Console](https://console.aws.amazon.com/iam/home)
2. Click **Users** → **Create user**
3. Name: `milkly-s3-access`
4. Click **Next** → **Attach policies directly**
5. Click **Create policy** and use this JSON (replace `YOUR-BUCKET-NAME`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR-BUCKET-NAME",
        "arn:aws:s3:::YOUR-BUCKET-NAME/*"
      ]
    }
  ]
}
```

6. Name the policy (e.g., `milkly-s3-policy`) and create it
7. Attach this policy to the user
8. Select the user → **Security credentials** tab
9. Click **Create access key**
10. Select "Application running outside AWS"
11. Copy the **Access Key ID** and **Secret Access Key**

## 6. Configure Environment Variables

Add to your `.env`:

```env
S3_BUCKET=milkly-media-prod
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=your-secret-key
```

### Optional Settings

```env
# For S3-compatible services (Cloudflare R2, MinIO, etc.)
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com

# CDN URL for public assets (if using CloudFront)
S3_PUBLIC_BASE_URL=https://cdn.yourdomain.com
```

## Cloudflare R2 Alternative

If using Cloudflare R2 instead of AWS S3:

1. Create an R2 bucket in [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Create an API token with R2 read/write permissions
3. Configure:

```env
S3_BUCKET=your-r2-bucket
S3_REGION=auto
S3_ACCESS_KEY_ID=your-r2-access-key
S3_SECRET_ACCESS_KEY=your-r2-secret-key
S3_ENDPOINT=https://YOUR-ACCOUNT-ID.r2.cloudflarestorage.com
```

## Troubleshooting

### "Access Denied" errors
- Check IAM policy has correct bucket ARN
- Verify access keys are correct
- Ensure bucket policy allows the action

### CORS errors in browser
- Verify CORS configuration is saved
- Check AllowedOrigins includes your domain

### Signed URLs not working
- Check S3_REGION matches your bucket's region
- Verify IAM user has `s3:GetObject` permission
