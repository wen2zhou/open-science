"""Public contract tests for the deterministic paper-narrative helper."""

import inspect
import json

from kernel import narrative_review_schema, narrative_review_task, paper_brief_schema


def test_public_signatures():
    assert str(inspect.signature(paper_brief_schema)) == "()"
    assert str(inspect.signature(narrative_review_schema)) == "()"
    assert str(inspect.signature(narrative_review_task)) == "(brief, deck_vid, rules_vid)"


def test_paper_brief_schema_preserves_editorial_fields():
    schema = paper_brief_schema()
    assert schema["type"] == "object"
    assert schema["required"] == ["pitch", "vision", "figures"]
    assert set(schema["properties"]) == {
        "pitch",
        "vision",
        "audience",
        "most_arresting_asset",
        "figures",
    }
    figure = schema["properties"]["figures"]["items"]
    assert figure["required"] == ["key", "claim"]
    assert set(figure["properties"]) == {"key", "claim", "composite_vid"}
    json.dumps(schema)


def test_review_schema_preserves_story_decisions_and_convergence_fields():
    schema = narrative_review_schema()
    assert schema["required"] == [
        "hook_verdict",
        "figure_moves",
        "missing_panels",
        "kill_list",
        "arc",
        "boldest_defensible_fig1",
    ]
    props = schema["properties"]
    assert props["hook_verdict"]["properties"]["would_send_for_review"]["enum"] == [
        "yes",
        "weak",
        "no",
    ]
    assert props["arc"]["items"]["properties"]["role"]["enum"] == [
        "hook",
        "mechanism",
        "evidence",
        "application",
        "supplement",
    ]
    assert props["kill_list"]["items"]["properties"]["demote_to"]["enum"] == [
        "supplement",
        "caption",
        "delete",
    ]
    json.dumps(schema)


def test_review_task_names_artifacts_claims_and_every_editorial_move():
    task = narrative_review_task(
        {
            "pitch": "Treatment restores function.",
            "vision": "Readers can select responders.",
            "audience": "translational scientists",
            "most_arresting_asset": "Figure 1B",
            "figures": [
                {"key": "Fig1", "claim": "Treatment restores function"},
                {"key": "Fig2", "caption": "Mechanism is receptor dependent"},
            ],
        },
        "deck-v7",
        "rules-v2",
    )
    for expected in [
        "Treatment restores function.",
        "Readers can select responders.",
        "translational scientists",
        "Figure 1B",
        "{{artifact:deck-v7}}",
        "{{artifact:rules-v2}}",
        "Fig1: Treatment restores function",
        "Fig2: Mechanism is receptor dependent",
        "Hook test",
        "arc",
        "move content between figures",
        "missing panels",
        "kill list",
        "boldest defensible Fig 1",
        "Return ONLY structured output",
    ]:
        assert expected in task


if __name__ == "__main__":
    test_public_signatures()
    test_paper_brief_schema_preserves_editorial_fields()
    test_review_schema_preserves_story_decisions_and_convergence_fields()
    test_review_task_names_artifacts_claims_and_every_editorial_move()
