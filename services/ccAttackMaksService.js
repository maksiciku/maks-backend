"use strict";

const path =
  require("path");

const {
  spawn,
} =
  require("child_process");

const { Pool } =
  require("pg");

/*
 * =====================================================
 * ATTACK MAKS
 * =====================================================
 *
 * SECURITY PRINCIPLES
 *
 * - Browser NEVER supplies a command.
 * - Browser NEVER supplies a database URL.
 * - Browser NEVER supplies test file paths.
 * - Test runner is pinned to maks_test.
 * - Only one full attack may run at once.
 * - Results come from real Node test output.
 * - Production DB is never used by destructive tests.
 * =====================================================
 */

const BACKEND_ROOT =
  path.resolve(
    __dirname,
    ".."
  );

const INTEGRATION_TEST_FILES = [
  "authAbuseAttack.test.js",
  "authTenantIsolation.test.js",
  "bookingTableAttack.test.js",
  "cashupAttack.test.js",
  "financialAttack.test.js",
  "kdsStateAttack.test.js",
  "kioskAuthoritativeLifecycle.test.js",
  "kioskQrAttackSuite.test.js",
  "orderPaymentKdsLifecycle.test.js",
  "orgUsersAttack.test.js",
  "posAuthAuthorityAttack.test.js",
  "publicAbuseAttack.test.js",
  "publicQrAuthoritativePricing.test.js",
  "qrKioskLifecycleAttack.test.js",
  "resourceTenantIsolation.test.js",
  "sharedKdsIsolationAttack.test.js",
  "stockOverrideAttack.test.js",
  "stockSupplierAttack.test.js",
  "tableLifecycleAttack.test.js",
  "tablesBookingsTenantIsolation.test.js",
  "voidCloseConcurrency.test.js",
  "voucherPricingAuthorityAttack.test.js",
];

const MAX_OUTPUT_CHARS =
  250_000;

const MAX_FAILURES =
  200;

const ATTACK_TIMEOUT_MS =
  Number(
    process.env
      .MAKS_ATTACK_TIMEOUT_MS ||
      15 * 60 * 1000
  );

let activeRun =
  null;

/*
 * =====================================================
 * DATABASE SAFETY
 * =====================================================
 */

function getAttackDatabaseUrl() {
  const value =
    String(
      process.env
        .MAKS_ATTACK_DATABASE_URL ||
        ""
    ).trim();

  if (!value) {
    const err =
      new Error(
        "MAKS_ATTACK_DATABASE_URL is not configured."
      );

    err.code =
      "ATTACK_DATABASE_NOT_CONFIGURED";

    err.statusCode =
      503;

    throw err;
  }

  return value;
}

function parseDatabaseName(
  connectionString
) {
  let parsed;

  try {
    parsed =
      new URL(
        connectionString
      );
  } catch {
    const err =
      new Error(
        "Attack database URL is invalid."
      );

    err.code =
      "ATTACK_DATABASE_URL_INVALID";

    err.statusCode =
      500;

    throw err;
  }

  return decodeURIComponent(
    String(
      parsed.pathname ||
        ""
    ).replace(
      /^\/+/,
      ""
    )
  );
}

async function assertAttackDatabaseSafe() {
  const databaseUrl =
    getAttackDatabaseUrl();

  const configuredName =
    parseDatabaseName(
      databaseUrl
    );

  if (
    configuredName !==
    "maks_test"
  ) {
    const err =
      new Error(
        `Attack MAKS refused database "${configuredName}". Only maks_test is permitted.`
      );

    err.code =
      "ATTACK_DATABASE_UNSAFE";

    err.statusCode =
      503;

    throw err;
  }

  /*
   * Independent verification directly against
   * the configured attack database.
   */
  const pool =
    new Pool({
      connectionString:
        databaseUrl,

      max:
        1,
    });

  try {
    const result =
      await pool.query(`
        SELECT
          current_database()
            AS database_name
      `);

    const liveName =
      String(
        result.rows?.[0]
          ?.database_name ||
          ""
      );

    if (
      liveName !==
      "maks_test"
    ) {
      const err =
        new Error(
          `Attack MAKS database verification failed. Connected to "${liveName}".`
        );

      err.code =
        "ATTACK_DATABASE_UNSAFE";

      err.statusCode =
        503;

      throw err;
    }

    return {
      databaseUrl,
      databaseName:
        liveName,
    };
  } finally {
    await pool.end();
  }
}

/*
 * =====================================================
 * OUTPUT PARSING
 * =====================================================
 */

function cleanLine(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /\u001b\[[0-9;]*m/g,
      ""
    )
    .trim();
}

function parseMetric(
  output,
  label
) {
  const regex =
    new RegExp(
      `(?:^|\\n)\\s*[ℹ#]?\\s*${label}\\s+(\\d+)\\s*$`,
      "gmi"
    );

  let match;
  let latest =
    null;

  while (
    (
      match =
        regex.exec(output)
    )
  ) {
    latest =
      Number(
        match[1]
      );
  }

  return latest;
}

function parseDuration(
  output
) {
  const regex =
    /(?:^|\n)\s*[ℹ#]?\s*duration_ms\s+([0-9.]+)\s*$/gmi;

  let match;
  let latest =
    null;

  while (
    (
      match =
        regex.exec(output)
    )
  ) {
    latest =
      Number(
        match[1]
      );
  }

  return latest;
}

function parseSuiteResults(output) {
  const lines =
    String(output || "")
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean);

  const results = [];
  const seen = new Set();

  function addResult(status, name, durationMs = null) {
    const cleanName =
      String(name || "")
        .replace(/^Subtest:\s*/i, "")
        .trim();

    if (!cleanName) {
      return;
    }

    const key =
      `${status}:${cleanName}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    results.push({
      status,
      name: cleanName,
      duration_ms:
        durationMs != null
          ? Number(durationMs)
          : null,
    });
  }

  for (const line of lines) {
    /*
     * Direct node:test output:
     *
     * ✔ test name (4.2ms)
     * ✖ test name (5.1ms)
     */

    let match =
      line.match(
        /^(?:#\s*)?✔\s+(.+?)(?:\s+\(([0-9.]+)ms\))?$/
      );

    if (match) {
      addResult(
        "passed",
        match[1],
        match[2]
      );

      continue;
    }

    match =
      line.match(
        /^(?:#\s*)?✖\s+(.+?)(?:\s+\(([0-9.]+)ms\))?$/
      );

    if (match) {
      addResult(
        "failed",
        match[1],
        match[2]
      );

      continue;
    }

    /*
     * TAP output produced by node --test when
     * multiple test files are executed together:
     *
     * ok 12 - some test
     * not ok 13 - some failed test
     */

    match =
      line.match(
        /^ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/i
      );

    if (match) {
      addResult(
        "passed",
        match[1]
      );

      continue;
    }

    match =
      line.match(
        /^not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/i
      );

    if (match) {
      addResult(
        "failed",
        match[1]
      );
    }
  }

  return results;
}

function parseFailures(output) {
  const lines =
    String(output || "")
      .split(/\r?\n/);

  const failures = [];
  const seen = new Set();

  function recordFailure(
    title,
    detailLines
  ) {
    const cleanTitle =
      cleanLine(title)
        .replace(/^✖\s*/, "")
        .replace(
          /^not ok\s+\d+\s+-\s+/i,
          ""
        )
        .trim();

    if (
      !cleanTitle ||
      seen.has(cleanTitle)
    ) {
      return;
    }

    seen.add(cleanTitle);

    failures.push({
      title:
        cleanTitle,

      detail:
        detailLines
          .map(cleanLine)
          .filter(Boolean)
          .join("\n")
          .slice(0, 8000),
    });
  }

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line =
      cleanLine(lines[i]);

    const directFailure =
      /^(?:#\s*)?✖\s+/.test(
        line
      );

    const tapFailure =
      /^not ok\s+\d+\s+-\s+/i.test(
        line
      );

    if (
      !directFailure &&
      !tapFailure
    ) {
      continue;
    }

    const detail = [];

    for (
      let j = i + 1;
      j < Math.min(
        lines.length,
        i + 40
      );
      j++
    ) {
      const next =
        cleanLine(lines[j]);

      if (
        /^(?:#\s*)?✔\s+/.test(next) ||
        /^(?:#\s*)?✖\s+/.test(next) ||
        /^ok\s+\d+\s+-\s+/i.test(next) ||
        /^not ok\s+\d+\s+-\s+/i.test(next) ||
        /^ℹ\s+tests\b/i.test(next)
      ) {
        break;
      }

      if (next) {
        detail.push(next);
      }
    }

    recordFailure(
      line,
      detail
    );

    if (
      failures.length >=
      MAX_FAILURES
    ) {
      break;
    }
  }

  return failures;
}

function parseAttackOutput(
  output
) {
  const total =
    parseMetric(
      output,
      "tests"
    ) || 0;

  const passed =
    parseMetric(
      output,
      "pass"
    ) || 0;

  const failed =
    parseMetric(
      output,
      "fail"
    ) || 0;

  const skipped =
    parseMetric(
      output,
      "skipped"
    ) || 0;

  const cancelled =
    parseMetric(
      output,
      "cancelled"
    ) || 0;

  const todo =
    parseMetric(
      output,
      "todo"
    ) || 0;

  const duration =
    parseDuration(
      output
    ) || 0;

  const suiteResults =
  parseSuiteResults(output);

let failures =
  parseFailures(output);

/*
 * Never allow Attack MAKS to report failed tests
 * without exposing at least their names.
 */
if (
  failed > 0 &&
  failures.length === 0
) {
  failures =
    suiteResults
      .filter(
        (item) =>
          item.status === "failed"
      )
      .map(
        (item) => ({
          title:
            item.name,

          detail:
            "The test runner reported this assertion as failed. Full runner evidence is available below.",
        })
      );
}

return {
  total,
  passed,
  failed,
  skipped,
  cancelled,
  todo,

  duration_ms:
    Math.round(duration),

  suite_results:
    suiteResults,

  failures,
};
}

/*
 * =====================================================
 * DATABASE RECORD HELPERS
 * =====================================================
 */

async function createRunRecord(
  req
) {
  const row =
    await req.qGet(
      `
      INSERT INTO public.cc_attack_runs
      (
        status,

        started_by_admin_id,
        started_by_email,

        environment,
        database_name,

        created_at
      )

      VALUES
      (
        'queued',

        $1,
        $2,

        'maks_test',
        'maks_test',

        NOW()
      )

      RETURNING *
      `,
      [
        Number(
          req.platformAdmin.id
        ),

        req.platformAdmin
          .email ||
          null,
      ]
    );

  return row;
}

async function writeAudit(
  req,
  {
    action,
    runId,
    meta = {},
  }
) {
  await req.qRun(
    `
    INSERT INTO public.platform_admin_audit
    (
      admin_user_id,
      action,
      target_restaurant_id,
      entity,
      entity_id,
      meta,
      created_at
    )

    VALUES
    (
      $1,
      $2,
      NULL,
      'cc_attack_runs',
      $3,
      $4::jsonb,
      NOW()
    )
    `,
    [
      Number(
        req.platformAdmin.id
      ),

      action,

      String(
        runId
      ),

      JSON.stringify(
        meta
      ),
    ]
  );
}

/*
 * =====================================================
 * RUNNER
 * =====================================================
 */

async function startAttackRun(
  req
) {
  if (
    activeRun &&
    activeRun.status ===
      "running"
  ) {
    const err =
      new Error(
        "Attack MAKS is already running."
      );

    err.code =
      "ATTACK_ALREADY_RUNNING";

    err.statusCode =
      409;

    err.runId =
      activeRun.id;

    throw err;
  }

  const safe =
    await assertAttackDatabaseSafe();

  const run =
    await createRunRecord(
      req
    );

  const runId =
    Number(
      run.id
    );

  /*
   * Copy only the minimum admin identity needed for
   * asynchronous audit/finalization.
   */
  const admin = {
    id:
      Number(
        req.platformAdmin.id
      ),

    email:
      req.platformAdmin
        .email ||
      "",
  };

  activeRun = {
    id:
      runId,

    status:
      "running",

    startedAt:
      Date.now(),

    output:
      "",

    current:
      "",

    child:
      null,
  };

  await req.qRun(
    `
    UPDATE public.cc_attack_runs

    SET
      status =
        'running',

      started_at =
        NOW()

    WHERE id =
      $1
    `,
    [
      runId,
    ]
  );

  await writeAudit(
    req,
    {
      action:
        "CC_ATTACK_MAKS_STARTED",

      runId,

      meta: {
        database:
          safe.databaseName,

        environment:
          "maks_test",

        suite_count:
          INTEGRATION_TEST_FILES.length,
      },
    }
  );

  /*
   * Start asynchronously.
   *
   * Do NOT await this from the HTTP request.
   */
  launchChildProcess({
    runId,
    admin,

    databaseUrl:
      safe.databaseUrl,

    qRun:
      req.qRun,

    qGet:
      req.qGet,
  });

  return {
    id:
      runId,

    status:
      "running",

    database_name:
      safe.databaseName,

    environment:
      "maks_test",

    suite_count:
      INTEGRATION_TEST_FILES.length,
  };
}

function launchChildProcess({
  runId,
  admin,
  databaseUrl,
  qRun,
}) {
  const testPaths =
    INTEGRATION_TEST_FILES.map(
      (name) =>
        path.join(
          BACKEND_ROOT,
          "tests",
          "integration",
          name
        )
    );

  /*
   * IMPORTANT:
   *
   * Each test file is now executed directly and sequentially.
   *
   * We deliberately DO NOT use:
   *
   *   node --test file1 file2 ...
   *
   * Node 20's multi-file test-runner transport has produced
   * intermittent "Unable to deserialize cloned data" failures
   * even when the exact test file passes when executed directly.
   *
   * Security boundaries remain unchanged:
   *
   * - No shell.
   * - No browser-supplied args.
   * - No browser-supplied paths.
   * - DATABASE_URL is the already-verified maks_test URL.
   * - Only one child test process exists at a time.
   */

  let output = "";

  const aggregate = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
    duration_ms: 0,
    suite_results: [],
    failures: [],
  };

  const suiteSeen =
    new Set();

  const failureSeen =
    new Set();

  const startedAt =
    Date.now();

  const appendOutput =
    (chunk) => {
      const text =
        String(
          chunk || ""
        );

      output +=
        text;

      /*
       * Keep raw evidence bounded.
       *
       * Structured results are aggregated separately,
       * so trimming old raw console output does not lose
       * the real test totals.
       */
      if (
        output.length >
        MAX_OUTPUT_CHARS * 2
      ) {
        output =
          output.slice(
            -MAX_OUTPUT_CHARS
          );
      }

      if (
        activeRun?.id ===
        runId
      ) {
        activeRun.output =
          output.slice(
            -MAX_OUTPUT_CHARS
          );

        const lines =
          text
            .split(
              /\r?\n/
            )
            .map(
              cleanLine
            )
            .filter(
              Boolean
            );

        if (
          lines.length
        ) {
          activeRun.current =
            lines[
              lines.length - 1
            ];
        }
      }
    };

  const mergeParsedResult =
    ({
      parsed,
      fileName,
      exitCode,
    }) => {
      aggregate.total +=
        Number(
          parsed.total || 0
        );

      aggregate.passed +=
        Number(
          parsed.passed || 0
        );

      aggregate.failed +=
        Number(
          parsed.failed || 0
        );

      aggregate.skipped +=
        Number(
          parsed.skipped || 0
        );

      aggregate.cancelled +=
        Number(
          parsed.cancelled || 0
        );

      aggregate.todo +=
        Number(
          parsed.todo || 0
        );

      for (
        const item of
        parsed.suite_results || []
      ) {
        const key =
          `${item.status}:${item.name}`;

        if (
          suiteSeen.has(
            key
          )
        ) {
          continue;
        }

        suiteSeen.add(
          key
        );

        aggregate.suite_results.push(
          item
        );
      }

      for (
        const failure of
        parsed.failures || []
      ) {
        const title =
          String(
            failure?.title || ""
          ).trim();

        if (
          !title ||
          failureSeen.has(
            title
          )
        ) {
          continue;
        }

        failureSeen.add(
          title
        );

        aggregate.failures.push(
          failure
        );
      }

      /*
       * Fail closed if Node exits unsuccessfully but did not
       * provide an assertion-level failure that we could parse.
       *
       * This catches infrastructure crashes without pretending
       * that MAKS passed.
       */
      if (
        exitCode !== 0 &&
        Number(
          parsed.failed || 0
        ) === 0
      ) {
        const title =
          `${fileName} runner failure`;

        aggregate.total +=
          1;

        aggregate.failed +=
          1;

        const resultKey =
          `failed:${title}`;

        if (
          !suiteSeen.has(
            resultKey
          )
        ) {
          suiteSeen.add(
            resultKey
          );

          aggregate.suite_results.push({
            status:
              "failed",

            name:
              title,

            duration_ms:
              null,
          });
        }

        if (
          !failureSeen.has(
            title
          )
        ) {
          failureSeen.add(
            title
          );

          aggregate.failures.push({
            title,

            detail:
              `The direct Node process for ${fileName} exited with code ${exitCode}.`,
          });
        }
      }

      /*
       * A test file that exits successfully while reporting
       * zero tests is also suspicious and must not silently pass.
       */
      if (
        exitCode === 0 &&
        Number(
          parsed.total || 0
        ) === 0
      ) {
        const title =
          `${fileName} reported zero tests`;

        aggregate.total +=
          1;

        aggregate.failed +=
          1;

        const resultKey =
          `failed:${title}`;

        if (
          !suiteSeen.has(
            resultKey
          )
        ) {
          suiteSeen.add(
            resultKey
          );

          aggregate.suite_results.push({
            status:
              "failed",

            name:
              title,

            duration_ms:
              null,
          });
        }

        if (
          !failureSeen.has(
            title
          )
        ) {
          failureSeen.add(
            title
          );

          aggregate.failures.push({
            title,

            detail:
              `The direct Node process for ${fileName} exited successfully but reported zero tests.`,
          });
        }
      }
    };

  const runOneFile =
    (
      testPath,
      index
    ) =>
      new Promise(
        (resolve) => {
          const fileName =
            path.basename(
              testPath
            );

          const elapsed =
            Date.now() -
            startedAt;

          const remaining =
            ATTACK_TIMEOUT_MS -
            elapsed;

          if (
            remaining <= 0
          ) {
            resolve({
              fileName,
              fileOutput:
                "",
              exitCode:
                null,
              timedOut:
                true,
              spawnError:
                null,
            });

            return;
          }

          const heading =
            `\n\n=== ATTACK SUITE ${index + 1}/${testPaths.length}: ${fileName} ===\n`;

          appendOutput(
            heading
          );

          if (
            activeRun?.id ===
            runId
          ) {
            activeRun.current =
              `Running ${fileName} (${index + 1}/${testPaths.length})`;
          }

          let fileOutput =
            "";

          const appendFileOutput =
            (chunk) => {
              const text =
                String(
                  chunk || ""
                );

              fileOutput +=
                text;

              if (
                fileOutput.length >
                MAX_OUTPUT_CHARS * 2
              ) {
                fileOutput =
                  fileOutput.slice(
                    -MAX_OUTPUT_CHARS
                  );
              }

              appendOutput(
                text
              );
            };

          /*
           * IMPORTANT:
           *
           * Direct execution is intentional.
           *
           * These files use node:test internally, so:
           *
           *   node testFile.js
           *
           * still executes their real tests while avoiding the
           * parent multi-file serialization layer.
           */
          const child =
            spawn(
              process.execPath,
              [
                testPath,
              ],
              {
                cwd:
                  BACKEND_ROOT,

                shell:
                  false,

                env: {
                  ...process.env,

                  NODE_ENV:
                    "test",

                  MAKS_TEST_MODE:
                    "1",

                  DATABASE_URL:
                    databaseUrl,
                },

                stdio: [
                  "ignore",
                  "pipe",
                  "pipe",
                ],
              }
            );

          if (
            activeRun?.id ===
            runId
          ) {
            activeRun.child =
              child;
          }

          child.stdout.on(
            "data",
            appendFileOutput
          );

          child.stderr.on(
            "data",
            appendFileOutput
          );

          let settled =
            false;

          let timedOut =
            false;

          let forceKillTimer =
            null;

          const finish =
            (result) => {
              if (
                settled
              ) {
                return;
              }

              settled =
                true;

              clearTimeout(
                timeout
              );

              if (
                forceKillTimer
              ) {
                clearTimeout(
                  forceKillTimer
                );
              }

              if (
                activeRun?.id ===
                runId &&
                activeRun.child ===
                child
              ) {
                activeRun.child =
                  null;
              }

              resolve({
                fileName,
                fileOutput,
                ...result,
              });
            };

          const timeout =
            setTimeout(
              () => {
                timedOut =
                  true;

                appendOutput(
                  `\n❌ Attack MAKS timeout reached while running ${fileName}.\n`
                );

                try {
                  child.kill(
                    "SIGTERM"
                  );
                } catch {}

                forceKillTimer =
                  setTimeout(
                    () => {
                      if (
                        settled
                      ) {
                        return;
                      }

                      try {
                        child.kill(
                          "SIGKILL"
                        );
                      } catch {}
                    },
                    2000
                  );

                forceKillTimer
                  .unref?.();
              },
              remaining
            );

          child.on(
            "error",
            (err) => {
              appendFileOutput(
                `\n${err.stack || err.message || err}\n`
              );

              finish({
                exitCode:
                  null,

                timedOut:
                  false,

                spawnError:
                  err,
              });
            }
          );

          child.on(
            "close",
            (code) => {
              finish({
                exitCode:
                  code,

                timedOut,

                spawnError:
                  null,
              });
            }
          );
        }
      );

  /*
   * The HTTP request has already returned.
   *
   * This async orchestration intentionally runs in the
   * background exactly like the old single child process.
   */
  void (
    async () => {
      let overallExitCode =
        0;

      let timedOut =
        false;

      let spawnError =
        null;

      try {
        for (
          let i = 0;
          i < testPaths.length;
          i++
        ) {
          const result =
            await runOneFile(
              testPaths[i],
              i
            );

          if (
            result.timedOut
          ) {
            timedOut =
              true;

            overallExitCode =
              1;

            break;
          }

          if (
            result.spawnError
          ) {
            spawnError =
              result.spawnError;

            overallExitCode =
              1;

            break;
          }

          const parsed =
            parseAttackOutput(
              result.fileOutput
            );

          mergeParsedResult({
            parsed,

            fileName:
              result.fileName,

            exitCode:
              result.exitCode,
          });

          if (
            result.exitCode !==
            0
          ) {
            /*
             * Continue through the remaining suites so Attack
             * MAKS reports every genuine failure in one run.
             */
            overallExitCode =
              1;
          }
        }
      } catch (err) {
        spawnError =
          err;

        overallExitCode =
          1;

        appendOutput(
          `\n${err.stack || err.message || err}\n`
        );
      }

      aggregate.duration_ms =
        Date.now() -
        startedAt;

      await finalizeAttackRun({
        runId,
        admin,
        qRun,
        output,

        exitCode:
          overallExitCode,

        timedOut,

        spawnError,

        parsedOverride:
          aggregate,
      });
    }
  )();
}

async function finalizeAttackRun({
  runId,
  admin,
  qRun,
  output,
  exitCode,
  timedOut,
  spawnError,
  parsedOverride = null,
}) {
  try {
    const parsed =
      parsedOverride ||
      parseAttackOutput(
        output
      );

    let status;

    if (
      timedOut ||
      spawnError
    ) {
      status =
        "error";
    } else if (
      exitCode === 0 &&
      parsed.failed === 0 &&
      parsed.total > 0
    ) {
      status =
        "passed";
    } else {
      status =
        "failed";
    }

    const outputTail =
      String(
        output || ""
      ).slice(
        -MAX_OUTPUT_CHARS
      );

    await qRun(
      `
      UPDATE public.cc_attack_runs

      SET
        status =
          $2,

        total_tests =
          $3,

        passed_tests =
          $4,

        failed_tests =
          $5,

        skipped_tests =
          $6,

        cancelled_tests =
          $7,

        todo_tests =
          $8,

        duration_ms =
          $9,

        suite_results =
          $10::jsonb,

        failures =
          $11::jsonb,

        output_tail =
          $12,

        finished_at =
          NOW()

      WHERE id =
        $1
      `,
      [
        runId,

        status,

        parsed.total,
        parsed.passed,
        parsed.failed,
        parsed.skipped,
        parsed.cancelled,
        parsed.todo,

        parsed.duration_ms,

        JSON.stringify(
          parsed.suite_results
        ),

        JSON.stringify(
          parsed.failures
        ),

        outputTail,
      ]
    );

    /*
     * Final platform audit.
     *
     * Use the same DB helper captured from the
     * authenticated CC request.
     */
    await qRun(
      `
      INSERT INTO public.platform_admin_audit
      (
        admin_user_id,
        action,
        target_restaurant_id,
        entity,
        entity_id,
        meta,
        created_at
      )

      VALUES
      (
        $1,
        $2,
        NULL,
        'cc_attack_runs',
        $3,
        $4::jsonb,
        NOW()
      )
      `,
      [
        admin.id,

        status ===
        "passed"
          ? "CC_ATTACK_MAKS_PASSED"
          : "CC_ATTACK_MAKS_FAILED",

        String(
          runId
        ),

        JSON.stringify({
          status,

          total:
            parsed.total,

          passed:
            parsed.passed,

          failed:
            parsed.failed,

          skipped:
            parsed.skipped,

          duration_ms:
            parsed.duration_ms,

          exit_code:
            exitCode,

          timed_out:
            timedOut,

          started_by_email:
            admin.email,
        }),
      ]
    );

    if (
      activeRun?.id ===
      runId
    ) {
      activeRun.status =
        status;

      activeRun.finishedAt =
        Date.now();

      activeRun.result =
        parsed;

      activeRun.current =
        status ===
        "passed"
          ? "MAKS survived the full attack suite."
          : "Attack MAKS detected one or more failures.";

      activeRun.child =
        null;
    }
  } catch (err) {
    console.error(
      "❌ Attack MAKS finalization failed:",
      err
    );

    if (
      activeRun?.id ===
      runId
    ) {
      activeRun.status =
        "error";

      activeRun.current =
        "Failed to persist Attack MAKS result.";

      activeRun.child =
        null;
    }
  }
}

/*
 * =====================================================
 * READ API
 * =====================================================
 */

async function getAttackRun(
  req,
  runId
) {
  const id =
    Number(
      runId
    );

  if (
    !Number.isInteger(
      id
    ) ||
    id <= 0
  ) {
    const err =
      new Error(
        "Invalid Attack MAKS run id."
      );

    err.code =
      "ATTACK_RUN_ID_INVALID";

    err.statusCode =
      400;

    throw err;
  }

  const row =
    await req.qGet(
      `
      SELECT *
      FROM public.cc_attack_runs

      WHERE id =
        $1

      LIMIT 1
      `,
      [
        id,
      ]
    );

  if (!row) {
    const err =
      new Error(
        "Attack MAKS run not found."
      );

    err.code =
      "ATTACK_RUN_NOT_FOUND";

    err.statusCode =
      404;

    throw err;
  }

  const live =
    activeRun?.id ===
    id
      ? {
          current:
            activeRun.current ||
            "",

          elapsed_ms:
            Date.now() -
            activeRun.startedAt,
        }
      : null;

  return {
    ...row,

    id:
      Number(
        row.id
      ),

    total_tests:
      Number(
        row.total_tests ||
        0
      ),

    passed_tests:
      Number(
        row.passed_tests ||
        0
      ),

    failed_tests:
      Number(
        row.failed_tests ||
        0
      ),

    skipped_tests:
      Number(
        row.skipped_tests ||
        0
      ),

    cancelled_tests:
      Number(
        row.cancelled_tests ||
        0
      ),

    todo_tests:
      Number(
        row.todo_tests ||
        0
      ),

    duration_ms:
      Number(
        row.duration_ms ||
        0
      ),

    suite_results:
      Array.isArray(
        row.suite_results
      )
        ? row.suite_results
        : [],

    failures:
      Array.isArray(
        row.failures
      )
        ? row.failures
        : [],

    live,
  };
}

async function listAttackRuns(
  req,
  limit =
    20
) {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        50,
        Number(
          limit ||
          20
        )
      )
    );

  const rows =
    await req.qAll(
      `
      SELECT
        id,
        status,

        started_by_admin_id,
        started_by_email,

        environment,
        database_name,

        total_tests,
        passed_tests,
        failed_tests,
        skipped_tests,

        duration_ms,

        started_at,
        finished_at,
        created_at

      FROM public.cc_attack_runs

      ORDER BY
        id DESC

      LIMIT $1
      `,
      [
        safeLimit,
      ]
    );

  return (
    rows || []
  ).map(
    (row) => ({
      ...row,

      id:
        Number(
          row.id
        ),

      total_tests:
        Number(
          row.total_tests ||
          0
        ),

      passed_tests:
        Number(
          row.passed_tests ||
          0
        ),

      failed_tests:
        Number(
          row.failed_tests ||
          0
        ),

      skipped_tests:
        Number(
          row.skipped_tests ||
          0
        ),

      duration_ms:
        Number(
          row.duration_ms ||
          0
        ),
    })
  );
}

async function getLatestAttackRun(
  req
) {
  const row =
    await req.qGet(
      `
      SELECT id

      FROM public.cc_attack_runs

      ORDER BY
        id DESC

      LIMIT 1
      `
    );

  if (!row?.id) {
    return null;
  }

  return getAttackRun(
    req,
    row.id
  );
}

function getActiveAttackRun() {
  if (
    !activeRun ||
    activeRun.status !==
      "running"
  ) {
    return null;
  }

  return {
    id:
      activeRun.id,

    status:
      activeRun.status,

    current:
      activeRun.current ||
      "",

    elapsed_ms:
      Date.now() -
      activeRun.startedAt,
  };
}

module.exports = {
  startAttackRun,
  getAttackRun,
  listAttackRuns,
  getLatestAttackRun,
  getActiveAttackRun,
  assertAttackDatabaseSafe,
};