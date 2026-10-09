"""Child process of stage-in that evaluates tool-author code: Cheetah templates and output filters.

It receives the manifest without presigned requests on stdin and an
environment without ``PLANET_MANIFEST_URL``, so tool code cannot reach the
job's upload URLs. It prints one JSON document as its last line of output.
"""

import json
import sys
from collections.abc import Mapping
from typing import Any

from planet_runtime.layout import (
    ensure_empty_file,
    Layout,
)

RESULT_PREFIX = "planet-template-result:"


def evaluate(manifest: Mapping[str, Any], layout: Layout) -> dict[str, Any]:
    from planet_runtime import galaxy_env
    from planet_runtime.evaluation import (
        EvaluationError,
        JobEvaluator,
    )

    galaxy_env.registry().to_xml_file(str(layout.registry_xml))
    evaluator = JobEvaluator(manifest, layout)
    plans = evaluator.plan_outputs()
    for record in manifest.get("outputs") or []:
        plan = plans.get(record["name"])
        if plan is None or not plan.filtered:
            ensure_empty_file(layout.output_path(record["uuid"]))
    evaluation = evaluator.build(plans)
    if not evaluation.command_line:
        raise EvaluationError("command line", "Tool has no command")
    keys = {id(hda): key for key, hda in evaluator.hdas.items()}
    return {
        "command_line": evaluation.command_line,
        "version_command_line": evaluation.version_command_line,
        "environment_variables": evaluation.environment_variables,
        "config_files": evaluation.config_files,
        "outputs": {
            name: {"filtered": plan.filtered, "format": plan.format, "label": plan.label}
            for name, plan in plans.items()
        },
        "input_datasets": {name: keys.get(id(data)) for name, data in evaluator.input_datasets.items()},
        "input_ext": str(evaluator.incoming.get("__input_ext") or "data"),
    }


def main() -> int:
    manifest = json.load(sys.stdin)
    layout = Layout.from_env()
    try:
        from planet_runtime.evaluation import EvaluationError

        result: dict[str, Any] = {"ok": True, **evaluate(manifest, layout)}
    except EvaluationError as e:
        result = {"ok": False, "phase": e.phase, "message": str(e)}
    except Exception as e:
        result = {"ok": False, "phase": "templating", "message": f"{type(e).__name__}: {e}"}
    sys.stdout.write("\n" + RESULT_PREFIX + json.dumps(result, default=str) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
