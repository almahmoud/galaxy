# Storage setup

Planet keeps dataset bytes in an S3-compatible bucket: Cloudflare R2, AWS S3, or Garage inside
the cluster for local use. The browser signs requests with the bucket keys and gives job pods
presigned URLs for single objects that expire one hour after the job's deadline; the keys
themselves stay in the browser.

All objects live under the prefix set in Planet:

| Prefix | Contents | Lifecycle |
| --- | --- | --- |
| `<prefix>/datasets/` | dataset files and metadata | kept |
| `<prefix>/jobs/` | job manifests, results and logs | deleted after 60 days |
| `<prefix>/uploads/` | uploads in progress | deleted after 7 days |
| `<prefix>/tools/` | installed tool bundles | kept |
| `<prefix>/state/` | encrypted snapshots of the browser's database | kept |

Incomplete multipart uploads are aborted after 30 days (7 days under `uploads/`). Job outputs
larger than 4.99 GiB are multipart uploads that Planet completes when it collects the job, which
can be days after the job ends.

## Planet settings

| Setting | R2 | AWS S3 | Garage |
| --- | --- | --- | --- |
| Endpoint | `https://<account-id>.r2.cloudflarestorage.com` | `https://s3.<region>.amazonaws.com` | `http://127.0.0.1:8002` |
| Cluster endpoint | same as endpoint | same as endpoint | `http://garage.planet-storage.svc:3900` |
| Region | `auto` | the bucket's region | `garage` |
| Path-style | on | off | on |
| Bucket | yours | yours | `planet` |

The cluster endpoint is the address job pods use for presigned URLs. For R2 buckets in the EU
jurisdiction the endpoint is `https://<account-id>.eu.r2.cloudflarestorage.com`. Presigned URLs
work only on these endpoints, not on custom domains.

The examples below use the prefix `planet` and the origin `https://planet.mylab.org`; replace
both with your own.

## Cloudflare R2

1. Create the bucket:

   ```sh
   npx wrangler r2 bucket create <bucket>
   ```

2. Create an API token: in the Cloudflare dashboard, open **R2 object storage**, select
   **Manage** next to **API Tokens**, choose the **Object Read & Write** permission and limit it
   to the bucket. Copy the **Access Key ID** and **Secret Access Key** into Planet.

3. Allow the Planet origin. Save as `cors.json`:

   ```json
   {
     "rules": [
       {
         "allowed": {
           "origins": ["https://planet.mylab.org"],
           "methods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
           "headers": [
             "authorization", "content-type", "content-md5", "content-disposition", "range",
             "if-match", "if-none-match", "x-amz-date", "x-amz-content-sha256",
             "x-amz-security-token", "x-amz-copy-source", "x-amz-copy-source-range",
             "x-amz-user-agent"
           ]
         },
         "exposeHeaders": [
           "ETag", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition",
           "Date", "x-amz-request-id", "x-amz-bucket-region", "x-amz-version-id"
         ],
         "maxAgeSeconds": 7200
       }
     ]
   }
   ```

   ```sh
   npx wrangler r2 bucket cors set <bucket> --file cors.json
   ```

4. Set the lifecycle rules. Save as `lifecycle.json` (ages in seconds):

   ```json
   {
     "rules": [
       {
         "id": "planet-uploads",
         "enabled": true,
         "conditions": { "prefix": "planet/uploads/" },
         "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 604800 } },
         "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
       },
       {
         "id": "planet-jobs",
         "enabled": true,
         "conditions": { "prefix": "planet/jobs/" },
         "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 5184000 } }
       },
       {
         "id": "abort-incomplete-multipart",
         "enabled": true,
         "conditions": { "prefix": "" },
         "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 2592000 } }
       }
     ]
   }
   ```

   ```sh
   npx wrangler r2 bucket lifecycle set <bucket> --file lifecycle.json
   ```

   This replaces every rule of the bucket, including R2's default rule that aborts incomplete
   multipart uploads after 7 days.

## AWS S3

1. Create the bucket and an IAM user with an access key and this policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
         "Resource": "arn:aws:s3:::<bucket>"
       },
       {
         "Effect": "Allow",
         "Action": [
           "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
           "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"
         ],
         "Resource": "arn:aws:s3:::<bucket>/planet/*"
       }
     ]
   }
   ```

   Presigned URLs signed with an IAM user's key are valid for up to 7 days, as Planet's job
   deadlines require. URLs signed with temporary credentials stop working when those expire.

2. Allow the Planet origin. Save as `cors.json`:

   ```json
   {
     "CORSRules": [
       {
         "AllowedOrigins": ["https://planet.mylab.org"],
         "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
         "AllowedHeaders": [
           "authorization", "content-type", "content-md5", "content-disposition", "range",
           "if-match", "if-none-match", "x-amz-date", "x-amz-content-sha256",
           "x-amz-security-token", "x-amz-copy-source", "x-amz-copy-source-range",
           "x-amz-user-agent"
         ],
         "ExposeHeaders": [
           "ETag", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition",
           "Date", "x-amz-request-id", "x-amz-bucket-region", "x-amz-version-id"
         ],
         "MaxAgeSeconds": 7200
       }
     ]
   }
   ```

   ```sh
   aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json
   ```

3. Set the lifecycle rules. Save as `lifecycle.json`:

   ```json
   {
     "Rules": [
       {
         "ID": "planet-uploads",
         "Status": "Enabled",
         "Filter": { "Prefix": "planet/uploads/" },
         "Expiration": { "Days": 7 },
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
       },
       {
         "ID": "planet-jobs",
         "Status": "Enabled",
         "Filter": { "Prefix": "planet/jobs/" },
         "Expiration": { "Days": 60 }
       },
       {
         "ID": "abort-incomplete-multipart",
         "Status": "Enabled",
         "Filter": {},
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 30 }
       }
     ]
   }
   ```

   ```sh
   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
     --lifecycle-configuration file://lifecycle.json
   ```

## Garage (local clusters)

`components/garage` runs [Garage](https://garagehq.deuxfleurs.fr/) v2.4.1 as a single node in the
namespace `planet-storage`, on a 20 GiB volume (10 GiB in `overlays/local`), without replication.
On first start Garage creates the bucket `planet` and an access key with read, write and owner
rights on it, from the Secret `planet-storage/garage-credentials`:

| Key | Value |
| --- | --- |
| `access-key-id` | `GK` followed by 24 lowercase hexadecimal characters, the format of keys Garage generates. Garage accepts any ID of at least 8 letters, digits, `-`, `_` or `.`. |
| `secret-access-key` | 64 lowercase hexadecimal characters. Garage accepts any secret of at least 16 printable ASCII characters. |
| `rpc-secret` | 64 lowercase hexadecimal characters (32 bytes). |

`dev-cluster.sh up` creates the Secret with random values, and `dev-cluster.sh storage` prints
the settings. On other clusters, apply the overlay and then create it:

```sh
kubectl -n planet-storage create secret generic garage-credentials \
  --from-literal=access-key-id="GK$(openssl rand -hex 12)" \
  --from-literal=secret-access-key="$(openssl rand -hex 32)" \
  --from-literal=rpc-secret="$(openssl rand -hex 32)"
```

Garage stores the key on first start and refuses to start if the Secret later holds a different
secret for the same key ID.

The browser reaches Garage through the gateway's S3 listener on port 8081
(`http://127.0.0.1:8002` with `dev-cluster.sh port-forward`). The gateway answers CORS for the
origins in `allowed-origins.map` and forwards requests with their `Host` header and path
unchanged, so the bucket needs no CORS rules. Job pods connect to
`http://garage.planet-storage.svc:3900` directly.

Lifecycle rules are optional for local use. The AWS S3 `lifecycle.json` above works with Garage:

```sh
AWS_ACCESS_KEY_ID=<access key ID> AWS_SECRET_ACCESS_KEY=<secret access key> \
  aws s3api put-bucket-lifecycle-configuration --endpoint-url http://127.0.0.1:8002 \
  --region garage --bucket planet --lifecycle-configuration file://lifecycle.json
```
