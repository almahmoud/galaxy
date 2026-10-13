// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildCompleteMultipartUploadXml, parseListObjectsV2 } from "./client";
import { parseErrorXml } from "./errors";
import { parseXml, xmlChildText, XmlParseError } from "./xml";

const LIST_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>planet-data</Name>
  <Prefix>planet/datasets/</Prefix>
  <KeyCount>3</KeyCount>
  <MaxKeys>2</MaxKeys>
  <Delimiter>/</Delimiter>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
  <Contents>
    <Key>planet/datasets/a&amp;b/data</Key>
    <LastModified>2026-10-09T10:00:00.000Z</LastModified>
    <ETag>&quot;9b2cf535f27731c974343645a3985328&quot;</ETag>
    <Size>1048576</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>planet/datasets/x/meta.json</Key>
    <LastModified>2026-10-09T10:00:01.000Z</LastModified>
    <ETag>"d41d8cd98f00b204e9800998ecf8427e-2"</ETag>
    <Size>12</Size>
  </Contents>
  <Contents>
    <Key>other/outside-prefix</Key>
    <Size>1</Size>
  </Contents>
  <CommonPrefixes><Prefix>planet/datasets/dir/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>planet/datasets/dir2/</Prefix></CommonPrefixes>
</ListBucketResult>`;

describe("parseXml", () => {
    it("parses nested elements, entities, CDATA and self-closing tags", () => {
        const root = parseXml(
            '<?xml version="1.0"?><!-- c --><a:Root xmlns:a="urn:x"><Item k="v>w">x &lt;&#65;&#x42;&gt; y</Item>' +
                "<Empty/><Data><![CDATA[<raw & text>]]></Data></a:Root>",
        );
        expect(root.name).toBe("Root");
        expect(xmlChildText(root, "Item")).toBe("x <AB> y");
        expect(xmlChildText(root, "Empty")).toBe("");
        expect(xmlChildText(root, "Data")).toBe("<raw & text>");
    });

    it("keeps leading and trailing spaces in text", () => {
        expect(xmlChildText(parseXml("<R><Key> spaced </Key></R>"), "Key")).toBe(" spaced ");
    });

    it.each([
        ["<R><A></R>", "mismatched tags"],
        ["<R>", "unclosed element"],
        ["<R/><S/>", "two roots"],
        ['<!DOCTYPE R [<!ENTITY x "y">]><R>&x;</R>', "doctype"],
        ["<R>&unknown;</R>", "unknown entity"],
        ["<R>a & b</R>", "bare ampersand"],
        ["", "empty document"],
        ["<1R/>", "invalid name"],
    ])("rejects %s (%s)", (source) => {
        expect(() => parseXml(source)).toThrow(XmlParseError);
    });

    it("limits nesting depth", () => {
        expect(() => parseXml("<a>".repeat(40) + "</a>".repeat(40))).toThrow(XmlParseError);
    });
});

describe("parseListObjectsV2", () => {
    it("returns keys relative to the prefix, common prefixes and the continuation token", () => {
        const result = parseListObjectsV2(parseXml(LIST_RESPONSE), "planet");
        expect(result.objects).toEqual([
            {
                key: "datasets/a&b/data",
                size: 1048576,
                etag: '"9b2cf535f27731c974343645a3985328"',
                lastModified: "2026-10-09T10:00:00.000Z",
            },
            {
                key: "datasets/x/meta.json",
                size: 12,
                etag: '"d41d8cd98f00b204e9800998ecf8427e-2"',
                lastModified: "2026-10-09T10:00:01.000Z",
            },
        ]);
        expect(result.commonPrefixes).toEqual(["datasets/dir/", "datasets/dir2/"]);
        expect(result.isTruncated).toBe(true);
        expect(result.nextContinuationToken).toBe("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=");
    });

    it("decodes url-encoded keys", () => {
        const xml =
            "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>" +
            "<Contents><Key>a+b%2Bc%2F%C3%A9</Key><Size>3</Size></Contents></ListBucketResult>";
        const result = parseListObjectsV2(parseXml(xml), "");
        expect(result.objects[0]?.key).toBe("a b+c/é");
        expect(result.isTruncated).toBe(false);
        expect(result.nextContinuationToken).toBeNull();
    });
});

describe("parseErrorXml", () => {
    it("reads Code, Message, RequestId, ServerTime and Region", () => {
        const parsed = parseErrorXml(
            "<Error><Code>RequestTimeTooSkewed</Code><Message>The difference between the request time and " +
                "the server's time is too large.</Message><RequestTime>20260101T000000Z</RequestTime>" +
                "<ServerTime>2026-01-01T01:00:00Z</ServerTime><RequestId>R1</RequestId></Error>",
        );
        expect(parsed).toEqual({
            code: "RequestTimeTooSkewed",
            message: "The difference between the request time and the server's time is too large.",
            requestId: "R1",
            serverTime: Date.UTC(2026, 0, 1, 1),
            region: null,
        });
        expect(
            parseErrorXml(
                "<Error><Code>AuthorizationHeaderMalformed</Code><Message>wrong region</Message>" +
                    "<Region>eu-west-1</Region></Error>",
            )?.region,
        ).toBe("eu-west-1");
    });

    it("returns null for non-error documents and non-XML text", () => {
        expect(parseErrorXml("<ListBucketResult/>")).toBeNull();
        expect(parseErrorXml("<html><body>Bad gateway</body></html>")).toBeNull();
        expect(parseErrorXml("upstream timed out")).toBeNull();
    });
});

describe("buildCompleteMultipartUploadXml", () => {
    it("sorts parts and escapes ETags", () => {
        expect(
            buildCompleteMultipartUploadXml([
                { partNumber: 2, etag: '"bbb"' },
                { partNumber: 1, etag: '"a&a"' },
            ]),
        ).toBe(
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
                '<Part><PartNumber>1</PartNumber><ETag>"a&amp;a"</ETag></Part>' +
                '<Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag></Part>' +
                "</CompleteMultipartUpload>",
        );
    });

    it("rejects empty, duplicate and out-of-range parts", () => {
        expect(() => buildCompleteMultipartUploadXml([])).toThrow(RangeError);
        expect(() =>
            buildCompleteMultipartUploadXml([
                { partNumber: 1, etag: "a" },
                { partNumber: 1, etag: "b" },
            ]),
        ).toThrow(RangeError);
        expect(() => buildCompleteMultipartUploadXml([{ partNumber: 10001, etag: "a" }])).toThrow(RangeError);
        expect(() => buildCompleteMultipartUploadXml([{ partNumber: 1, etag: "" }])).toThrow(RangeError);
    });
});
