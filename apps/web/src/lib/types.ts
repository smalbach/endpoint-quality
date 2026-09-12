/**
 * The shapes the API returns.
 *
 * They used to be written out here by hand, and the comment above them argued the duplication was
 * the right call while there was one consumer. It was, until a column changed and nothing
 * noticed: `run_steps` learned to have its bodies retired, the API started answering
 * `request: null`, and this file kept a type saying `request` was always there. A compiler cannot
 * catch a lie it was told twice.
 *
 * They live in `@eq/contracts` now, written once over a timestamp parameter — `Date` on the
 * server, `string` on the wire — and re-exported here so every screen keeps importing from
 * `@/lib/types` and the change stops at this file.
 */
export type {
  ApiTokenView,
  Assertion,
  CaseStatus,
  ConfigView,
  CoverageGap,
  CaptureSource,
  CoverageView,
  CurrentUser,
  Environment,
  EndpointBodyMode,
  EndpointBodyView,
  EndpointFormFieldView,
  EndpointHeaderView,
  EndpointImportResult,
  EndpointMethod,
  EndpointOrigin,
  EndpointPage,
  EndpointPathParameterView,
  EndpointQueryParameterView,
  EndpointStatus,
  EndpointView,
  SentRequestView,
  Member,
  MembersView,
  PendingInvitation,
  OperationScenarios,
  ProblemDetails,
  ProjectAuthType,
  ProjectAuthView,
  ProjectSummary,
  RequestBodyView,
  RequestPreviewView,
  RequestTemplateView,
  Role,
  Run,
  RunCase,
  RunCaseView,
  RunReport,
  RunSource,
  RunStatus,
  RunStep,
  RunTotals,
  RunView,
  DatasetRowsView,
  FailureKind,
  DatasetView,
  ScenarioView,
  ScenariosView,
  SuiteView,
  StepAuthorizesView,
  StepCheckView,
  StepConditionView,
  StepForEachView,
  StepRetryView,
  WorkflowCaptureView,
  WorkflowStepView,
  WorkflowView,
  WorkflowsView,
} from "@eq/contracts";
