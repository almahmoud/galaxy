/**
 * S3-compatible object storage client for pages, dedicated workers and the Service Worker.
 *
 * Requests are signed with SigV4 (aws4fetch) using a clock corrected from the server's Date header.
 * Keys are relative to the configured prefix. Failures throw S3Error; a request the browser could not
 * complete (network, CORS, mixed content or local network access) has code "network_blocked".
 */
export {
    buildCompleteMultipartUploadXml,
    createS3Client,
    type FetchFunction,
    parseListObjectsV2,
    type S3Body,
    type S3Client,
    type S3ClientOptions,
    type S3GetOptions,
    type S3ListedObject,
    type S3ListedPart,
    type S3ListOptions,
    type S3ListResult,
    type S3ObjectInfo,
    type S3Part,
    type S3PresignGetOptions,
    type S3PresignOptions,
    type S3PutOptions,
    type S3PutResult,
    type S3Range,
    type S3RequestOptions,
} from "./client";
export { isNotFound, isS3Error, S3Error } from "./errors";
export {
    buildCorsPolicy,
    CORS_ALLOWED_HEADERS,
    CORS_ALLOWED_METHODS,
    CORS_EXPOSE_HEADERS,
    CORS_MAX_AGE_SECONDS,
    type S3CorsPolicy,
    type S3SetupCheck,
    type S3SetupCheckId,
    type S3SetupOptions,
    type S3SetupReport,
    type S3SetupStatus,
} from "./setup";
export { MAX_PRESIGN_EXPIRES_SECONDS } from "./signer";
export type { S3Config } from "./url";
