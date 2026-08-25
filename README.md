Title: Autonomous Compliance Workflow Engine (Meridian Take-Home)
Author: Daniel Hsiao
Timeline: 48 Hours
1. The Objective

A one-paragraph summary of what you are building and why.

    Goal: Build a two-phase AI platform that allows non-technical users to define document compliance workflows visually, and then autonomously generates and self-heals a backend state machine to execute that logic.

    The Core Tension Resolved: I'm using a limited DAG to make it user-friendly, relying on the user's non technical capabilities of not understanding code, but with that restrict the freedom of the DAG to remain consistency with the state machine in the backend. The DAG serves as a constrained abstraction layer. It provides the visual flexibility non-technical users need to map linear business logic, while the underlying AI Review loop forces the resolution of edge cases. This ensures the output is a mathematically complete specification that can compile directly into a strict state machine. In simple terms, the user has the freedom of the "nouns" whereas the AI Review Agent reinforces the "verbs". 

2. Scope & Constraints

In Scope:

    React whiteboard with exactly 4 primitives (Channel, Artifact, Policy, Ledger). I chose these 4 primitives because it's all that required to generate what's needed for the AI. (Context, Action, Objective, Constraints)

    AI Review loop utilizing structured (multiple-choice) comments. (MC to remain consistency and avoids more ambiguity) Questions/Comments will be generated based on the "Golden" Frozen JSON format. 

    CLI-driven (Claude Code/Codex) code generation and self-healing loop.

    Temporal worker execution against 10 sample Composio emails.

Out of Scope:

    Custom LLM nodes within primitives

    Visual representation of error loops.

One key assumption: SOP is used by every user. 


3. System Architecture

4 zones: Interactive DAG/State Machine, Immutable Handoff, Zero-to-One Generation, and One-to-N Self-Healing.
https://lucid.app/lucidchart/0cd54a9b-917f-4eec-b28c-87dbfd840d57/edit?view_items=GH1n6aAV_5D9&page=0_0&invitationId=inv_705b1a77-2e4d-49c4-ab04-813c4217442c

4. The Data Model (The Immutable Handoff)
Sample Shared Registry Example (Boundaries Set for the AI Review Agent):
{
  "primitives": {
    "artifact": {
      "allowed_types": ["Commercial Invoice", "Certificate of Analysis", "Packing List", "Custom"],
      "required_resolution_keys": ["target_array", "required_fields"],
      "codegen_instructions": {
        "default": "Generate a strict object schema using 'required_fields' as string keys. Inject this schema into a runtime LLM tool call (e.g., Vercel AI SDK or OpenAI Python client) to semantically extract these fields from the unstructured pdfText. Force structured JSON output. Assign the validated data to the variable named in 'target_array'."
      }
    },
    "policy": {
      "allowed_rule_types": ["field_presence", "cross_reference"],
      "required_resolution_keys": ["on_fail"],
      "allowed_enum_mappings": {
        "on_fail": [
          "halt_workflow_immediately",
          "flag_item_and_continue"
        ]
      },
      "codegen_instructions": {
        "field_presence": "Write an 'if (!item.field)' check for each field in 'required_fields'.",
        "cross_reference": "Write a nested iteration block comparing the 'source' array against the 'target' array.",
        "halt_workflow_immediately": "Throw Temporal ApplicationFailure.",
        "flag_item_and_continue": "Append ID to ledger array; write 'continue' in loop."
      }
    }
  }
}

Sample Frozen JSON Spec:
{
  "process_id": "shipment_receiving_001",
  "channel": {
    "type": "email_inbox",
    "subject_match": "Pre-Alert Documents"
  },
  "artifacts": [
    {
      "id": "doc_1",
      "type": "Commercial Invoice",
      "target_array": "goods",
      "required_fields": ["HTS", "FDA Product Code", "NDC", "ANDA", "Reg No"]
    },
    {
      "id": "doc_2",
      "type": "Certificate of Analysis",
      "target_array": "batches",
      "required_fields": ["Batch Number"]
    },
    ...
  ],
  "policies": [
    {
      "rule_type": "field_presence",
      "target_artifact": "doc_1",
      "condition": "all_required_fields_present",
      "on_fail": "flag_good_and_invoice_failed"
    },
    {
      "rule_type": "cross_reference",
      "source": "doc_1.batch_number",
      "target": "doc_2.batch_number",
      "on_fail": "flag_batch_failed"
    },
    ...
  ],
  "ledger": [
    {"metric": "invoices_processed", "deduplicate_by": "invoice_number"},
    {"metric": "invoices_succeeded"},
    {"metric": "invoices_failed"},
    {"metric": "goods_failed"},
    {"metric": "batches_processed", "deduplicate_by": "batch_number"},
    {"metric": "batches_succeeded"},
    {"metric": "batches_failed"}
    {"metric": "failed_batch_ids", "target": "batch_number"}
  ]
}

5. Evaluation & Self-Healing Strategy

A run is deemed fully successful only when the Temporal worker terminates and outputs a Ledger matching the exact expected counts and states defined in the frozen specification:

    invoices_processed (with proper deduplication)

    invoices_succeeded / invoices_failed

    goods_failed (enforcing the 5-field requirement: HTS, FDA Product Code, NDC, ANDA, and Reg No)

    batches_processed, batches_succeeded, and batches_failed (verified via cross-referencing invoice line items against Certificate of Analysis batch numbers) 

When unexpected edge cases occur (e.g., a malformed PDF layout where an FDA product code is placed in a non-standard location), the system triggers a controlled self-healing loop:

    Trace Interception: The test runner halts on an assertion mismatch and generates a detailed error trace containing the failing email ID, expected vs. actual ledger counts, and specific policy violation logs.

    Context-Driven Debugging: The Self-Healing Agent ingests the error trace alongside the validation logic. Using the precise feedback from the stack trace, it localizes the parsing or extraction failure.

    Targeted Patching: The agent applies a localized code patch exclusively to the isolated validation and parsing section of the generated code (adjusting extraction prompts, regex patterns, or rule checks). Write permissions are strictly restricted away from the core Temporal orchestration layer and Composio integrations to prevent architectural hallucination or regression.

    Re-Evaluation: The test suite automatically re-runs. This cycle repeats autonomously or via human-in-the-loop CLI direction until all 10 test cases achieve a 100% pass rate.