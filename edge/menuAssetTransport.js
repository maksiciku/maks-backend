"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const fsp = fs.promises;

const DEFAULT_MAX_BYTES =
  4 * 1024 * 1024;

class MenuAssetTransportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "MenuAssetTransportError";
    this.code = code;

    if (details !== null) {
      this.details = details;
    }
  }
}

function positiveInteger(value, label) {
  const number = Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_ARGUMENT_INVALID",
      `${label} is invalid`
    );
  }

  return number;
}

function normalizeItemType(value) {
  const type = String(value || "")
    .trim()
    .toLowerCase();

  if (
    type === "meal" ||
    type === "meals"
  ) {
    return "meal";
  }

  if (
    type === "drink" ||
    type === "drinks"
  ) {
    return "drink";
  }

  if (
    type === "dessert" ||
    type === "desserts"
  ) {
    return "dessert";
  }

  throw new MenuAssetTransportError(
    "EDGE_MENU_ASSET_TYPE_INVALID",
    "Menu item type is invalid"
  );
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "")
    .trim()
    .replace(/\/+$/, "");

  if (!baseUrl) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_CLOUD_URL_REQUIRED",
      "Cloud URL is required"
    );
  }

  return baseUrl;
}

function safeTimeoutMs(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 10000;
  }

  return Math.max(
    1000,
    Math.min(
      60000,
      Math.round(number)
    )
  );
}

function safeMaxBytes(value) {
  const number = Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number < 1024 ||
    number > 20 * 1024 * 1024
  ) {
    return DEFAULT_MAX_BYTES;
  }

  return number;
}

function sha256Buffer(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
}

async function sha256File(filePath) {
  return new Promise(
    (resolve, reject) => {
      const hash =
        crypto.createHash("sha256");

      const stream =
        fs.createReadStream(filePath);

      stream.on("error", reject);

      stream.on(
        "data",
        (chunk) =>
          hash.update(chunk)
      );

      stream.on(
        "end",
        () =>
          resolve(
            hash.digest("hex")
          )
      );
    }
  );
}

function isPathInside(base, target) {
  const relative =
    path.relative(base, target);

  return (
    relative === "" ||
    (
      !relative.startsWith(
        `..${path.sep}`
      ) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    )
  );
}

function localMenuAssetDescriptor({
  restaurantId,
  photoUrl,
  uploadsRoot,
}) {
  const rid =
    positiveInteger(
      restaurantId,
      "restaurantId"
    );

  const raw =
    String(photoUrl || "").trim();

  if (!raw) {
    return {
      kind: "none",
    };
  }

  if (/^https?:\/\//i.test(raw)) {
    return {
      kind: "external",
      photoUrl: raw,
    };
  }

  const prefix =
    `/uploads/${rid}/menu-items/`;

  if (!raw.startsWith(prefix)) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path is not owned by the authenticated restaurant"
    );
  }

  const filename =
    raw.slice(prefix.length);

  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    path.basename(filename) !==
      filename
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path is invalid"
    );
  }

  let decoded = filename;

  try {
    decoded =
      decodeURIComponent(filename);
  } catch {
    decoded = filename;
  }

  if (
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded === "." ||
    decoded === ".."
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path is invalid"
    );
  }

  const root =
    path.resolve(uploadsRoot);

  const directory =
    path.resolve(
      root,
      String(rid),
      "menu-items"
    );

  const filePath =
    path.resolve(
      directory,
      filename
    );

  if (
    !isPathInside(root, directory) ||
    !isPathInside(
      directory,
      filePath
    ) ||
    filePath === directory
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Menu image path escaped the local uploads root"
    );
  }

  return {
    kind: "local",
    photoUrl: raw,
    filename,
    directory,
    filePath,
  };
}

async function existingLocalSha(
  descriptor
) {
  try {
    const stat =
      await fsp.lstat(
        descriptor.filePath
      );

    if (
      stat.isSymbolicLink() ||
      !stat.isFile()
    ) {
      return null;
    }

    return sha256File(
      descriptor.filePath
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readBodyBounded(
  response,
  maxBytes
) {
  if (
    !response?.body ||
    typeof response.body.getReader !==
      "function"
  ) {
    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (buffer.length > maxBytes) {
      throw new MenuAssetTransportError(
        "EDGE_MENU_ASSET_TOO_LARGE",
        "Menu asset response exceeded the maximum allowed size"
      );
    }

    return buffer;
  }

  const reader =
    response.body.getReader();

  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const {
        done,
        value,
      } = await reader.read();

      if (done) {
        break;
      }

      const chunk =
        Buffer.from(value);

      total += chunk.length;

      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best effort
        }

        throw new MenuAssetTransportError(
          "EDGE_MENU_ASSET_TOO_LARGE",
          "Menu asset response exceeded the maximum allowed size"
        );
      }

      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best effort
    }
  }

  return Buffer.concat(
    chunks,
    total
  );
}

async function installVerifiedAsset({
  descriptor,
  buffer,
  expectedSha,
  expectedSize,
  uploadsRoot,
  tempRoot,
}) {
  if (buffer.length !== expectedSize) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_SIZE_MISMATCH",
      "Menu asset size did not match Cloud metadata"
    );
  }

  const actualSha =
    sha256Buffer(buffer);

  if (actualSha !== expectedSha) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_HASH_MISMATCH",
      "Menu asset SHA-256 did not match Cloud metadata"
    );
  }

  await fsp.mkdir(
    path.resolve(uploadsRoot),
    {
      recursive: true,
    }
  );

  await fsp.mkdir(
    descriptor.directory,
    {
      recursive: true,
    }
  );

  const realUploadsRoot =
    await fsp.realpath(
      path.resolve(uploadsRoot)
    );

  const realDirectory =
    await fsp.realpath(
      descriptor.directory
    );

  if (
    !isPathInside(
      realUploadsRoot,
      realDirectory
    )
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_PATH_INVALID",
      "Local menu asset directory escaped the uploads root"
    );
  }

  const safeTempRoot =
    path.resolve(tempRoot);

  await fsp.mkdir(
    safeTempRoot,
    {
      recursive: true,
    }
  );

  const tempFile =
    path.join(
      safeTempRoot,
      `menu-${process.pid}-${crypto.randomUUID()}.part`
    );

  try {
    await fsp.writeFile(
      tempFile,
      buffer,
      {
        flag: "wx",
      }
    );

    const tempStat =
      await fsp.lstat(tempFile);

    if (
      !tempStat.isFile() ||
      tempStat.isSymbolicLink()
    ) {
      throw new MenuAssetTransportError(
        "EDGE_MENU_ASSET_TEMP_INVALID",
        "Menu asset temporary file is invalid"
      );
    }

    const tempSha =
      await sha256File(tempFile);

    if (tempSha !== expectedSha) {
      throw new MenuAssetTransportError(
        "EDGE_MENU_ASSET_HASH_MISMATCH",
        "Menu asset temporary file failed SHA-256 verification"
      );
    }

    await fsp.rename(
      tempFile,
      descriptor.filePath
    );
  } finally {
    try {
      await fsp.unlink(tempFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // best effort cleanup only
      }
    }
  }
}

async function reconcileMenuAssetsOnce({
  pool,
  cloudUrl,
  installationId,
  edgeSecret,
  restaurantId,

  uploadsRoot =
    path.join(
      process.cwd(),
      "uploads"
    ),

  tempRoot =
    path.join(
      path.dirname(
        path.resolve(uploadsRoot)
      ),
      ".maks-edge-menu-asset-tmp"
    ),

  maxBytes =
    DEFAULT_MAX_BYTES,

  timeoutMs =
    10000,

  fetchImpl =
    global.fetch,
}) {
  if (
    !pool ||
    typeof pool.query !==
      "function"
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_POOL_INVALID",
      "An explicit local PostgreSQL pool is required"
    );
  }

  if (
    typeof fetchImpl !==
      "function"
  ) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_FETCH_INVALID",
      "fetch implementation is required"
    );
  }

  const rid =
    positiveInteger(
      restaurantId,
      "restaurantId"
    );

  const iid =
    String(
      installationId || ""
    ).trim();

  const secret =
    String(
      edgeSecret || ""
    ).trim();

  if (!iid || !secret) {
    throw new MenuAssetTransportError(
      "EDGE_MENU_ASSET_AUTH_REQUIRED",
      "Edge installation credentials are required"
    );
  }

  const baseUrl =
    normalizeBaseUrl(cloudUrl);

  const safeMax =
    safeMaxBytes(maxBytes);

  const safeTimeout =
    safeTimeoutMs(timeoutMs);

  const result =
    await pool.query(
      `
      SELECT
        id,
        'meal'::text
          AS item_type,
        photo_url
      FROM
        public.meals
      WHERE
        restaurant_id = $1
        AND photo_url IS NOT NULL
        AND LENGTH(
          TRIM(photo_url)
        ) > 0

      UNION ALL

      SELECT
        id,
        LOWER(
          TRIM(type)
        ) AS item_type,
        photo_url
      FROM
        public.menu_items
      WHERE
        restaurant_id = $1
        AND photo_url IS NOT NULL
        AND LENGTH(
          TRIM(photo_url)
        ) > 0
        AND LOWER(
          TRIM(
            COALESCE(type, '')
          )
        ) IN (
          'drink',
          'drinks',
          'dessert',
          'desserts'
        )

      ORDER BY
        item_type ASC,
        id ASC
      `,
      [
        rid,
      ]
    );

  const summary = {
    success: true,
    scanned: 0,
    downloaded: 0,
    unchanged: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
  };

  for (
    const item of result.rows || []
  ) {
    summary.scanned += 1;

    let itemType;
    let descriptor;

    try {
      itemType =
        normalizeItemType(
          item.item_type
        );

      descriptor =
        localMenuAssetDescriptor({
          restaurantId: rid,
          photoUrl:
            item.photo_url,
          uploadsRoot,
        });
    } catch {
      summary.rejected += 1;
      continue;
    }

    if (
      descriptor.kind ===
        "external" ||
      descriptor.kind === "none"
    ) {
      summary.skipped += 1;
      continue;
    }

    try {
      const localSha =
        await existingLocalSha(
          descriptor
        );

      const headers = {
        "x-edge-installation-id":
          iid,
        "x-edge-secret":
          secret,
      };

      if (
        localSha &&
        /^[0-9a-f]{64}$/i.test(
          localSha
        )
      ) {
        headers[
          "x-maks-local-sha256"
        ] = localSha;
      }

      const response =
        await fetchImpl(
          `${baseUrl}/edge/assets/menu/${encodeURIComponent(
            itemType
          )}/${encodeURIComponent(
            String(item.id)
          )}/image`,
          {
            method: "GET",
            headers,
            signal:
              AbortSignal.timeout(
                safeTimeout
              ),
          }
        );

      if (response.status === 304) {
        if (!localSha) {
          throw new MenuAssetTransportError(
            "EDGE_MENU_ASSET_NOT_MODIFIED_WITHOUT_LOCAL",
            "Cloud returned not-modified without a verified local asset"
          );
        }

        summary.unchanged += 1;
        continue;
      }

      if (response.status !== 200) {
        throw new MenuAssetTransportError(
          "EDGE_MENU_ASSET_FETCH_REJECTED",
          `Cloud menu asset request failed with HTTP ${response.status}`
        );
      }

      const expectedSha =
        String(
          response.headers.get(
            "x-maks-asset-sha256"
          ) || ""
        )
          .trim()
          .toLowerCase();

      if (
        !/^[0-9a-f]{64}$/.test(
          expectedSha
        )
      ) {
        throw new MenuAssetTransportError(
          "EDGE_MENU_ASSET_HASH_REQUIRED",
          "Cloud menu asset response is missing a valid SHA-256"
        );
      }

      const expectedSize =
        Number(
          response.headers.get(
            "x-maks-asset-size"
          )
        );

      if (
        !Number.isSafeInteger(
          expectedSize
        ) ||
        expectedSize < 0 ||
        expectedSize > safeMax
      ) {
        throw new MenuAssetTransportError(
          "EDGE_MENU_ASSET_SIZE_INVALID",
          "Cloud menu asset response has an invalid size"
        );
      }

      const buffer =
        await readBodyBounded(
          response,
          safeMax
        );

      await installVerifiedAsset({
        descriptor,
        buffer,
        expectedSha,
        expectedSize,
        uploadsRoot,
        tempRoot,
      });

      summary.downloaded += 1;
    } catch {
      summary.failed += 1;
    }
  }

  summary.success =
    summary.rejected === 0 &&
    summary.failed === 0;

  return summary;
}

module.exports = {
  MenuAssetTransportError,
  DEFAULT_MAX_BYTES,
  isPathInside,
  localMenuAssetDescriptor,
  normalizeItemType,
  sha256Buffer,
  sha256File,
  reconcileMenuAssetsOnce,
};
