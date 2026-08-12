// lib/graphql/documents.ts
import { gql } from "@apollo/client";

// --- Reads --------------------------------------------------------------

export const MY_ORGS = gql`
  query MyOrgs {
    org_members {
      id
      role
      organization {
        id
        name
        usage_calls
        usage_limit
      }
    }
  }
`;

// The "single useful query" required by the assignment:
// organization -> workflows -> steps -> triggers -> most recent run -> status
export const ORG_WORKFLOWS_DETAILED = gql`
  query OrgWorkflowsDetailed($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      created_at
      workflow_steps(order_by: { position: asc }) {
        id
        position
        type
        config
      }
      workflow_triggers {
        id
        type
        enabled
        config
      }
      workflow_runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        started_at
        completed_at
        error
      }
      run_stats {
        completed_runs
        failed_runs
        avg_duration_seconds
      }
    }
  }
`;

export const WORKFLOW_BUILDER_QUERY = gql`
  query WorkflowBuilder($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      description
      org_id
      organization {
        id
        org_members {
          user_id
          role
        }
      }
      workflow_steps(order_by: { position: asc }) {
        id
        position
        type
        config
      }
      workflow_triggers {
        id
        type
        config
        enabled
      }
    }
  }
`;

export const WORKFLOW_RUN_STEP_RUNS_SUBSCRIPTION = gql`
  subscription StepRunsForRun($workflowRunId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $workflowRunId } }, order_by: { created_at: asc }) {
      id
      status
      input
      output
      error
      attempt_count
      approved_by
      approved_at
      started_at
      completed_at
      workflow_step {
        id
        position
        type
      }
    }
    workflow_runs_by_pk(id: $workflowRunId) {
      id
      status
      started_at
      completed_at
      error
    }
  }
`;

// --- Writes ---------------------------------------------------------------

export const CREATE_WORKFLOW = gql`
  mutation CreateWorkflow($org_id: uuid!, $name: String!, $description: String) {
    insert_workflows_one(object: { org_id: $org_id, name: $name, description: $description }) {
      id
    }
  }
`;

export const UPDATE_WORKFLOW = gql`
  mutation UpdateWorkflow($id: uuid!, $name: String, $description: String) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name, description: $description }) {
      id
    }
  }
`;

export const CREATE_STEP = gql`
  mutation CreateStep($workflow_id: uuid!, $position: Int!, $type: step_type!, $config: jsonb!) {
    insert_workflow_steps_one(
      object: { workflow_id: $workflow_id, position: $position, type: $type, config: $config }
    ) {
      id
    }
  }
`;

export const UPDATE_STEP = gql`
  mutation UpdateStep($id: uuid!, $position: Int, $config: jsonb) {
    update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: { position: $position, config: $config }) {
      id
    }
  }
`;

export const DELETE_STEP = gql`
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) {
      id
    }
  }
`;

export const CREATE_TRIGGER = gql`
  mutation CreateTrigger($workflow_id: uuid!, $type: trigger_type!, $config: jsonb!) {
    insert_workflow_triggers_one(object: { workflow_id: $workflow_id, type: $type, config: $config }) {
      id
    }
  }
`;

// --- Actions ----------------------------------------------------------------

export const TRIGGER_WORKFLOW_RUN = gql`
  mutation TriggerWorkflowRun($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      workflow_run_id
      status
    }
  }
`;

export const APPROVE_STEP = gql`
  mutation ApproveStep($step_run_id: uuid!) {
    approveStep(step_run_id: $step_run_id) {
      step_run_id
      workflow_run_id
      status
    }
  }
`;
