import { useEffect, useMemo, useState } from "react";
import { t } from "ttag";

import { useDescribeTableEditFormMutation } from "metabase/api";
import { getErrorMessage } from "metabase/api/utils/errors";
import {
  Alert,
  Button,
  Flex,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from "metabase/ui";
import type { TableId } from "metabase-types/api";

import type {
  EditableTableAction,
  EditableTableFormParameter,
  EditableTableRow,
} from "./types";

type TableEditingFormModalProps = {
  action: Exclude<EditableTableAction, "delete">;
  tableId: TableId;
  opened: boolean;
  initialRow?: EditableTableRow | null;
  onClose: () => void;
  onSubmit: (row: EditableTableRow) => Promise<void>;
  isSubmitting?: boolean;
};

export function TableEditingFormModal({
  action,
  tableId,
  opened,
  initialRow,
  onClose,
  onSubmit,
  isSubmitting = false,
}: TableEditingFormModalProps) {
  const [describeForm, describeFormResult] = useDescribeTableEditFormMutation();
  const [values, setValues] = useState<EditableTableRow>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) {
      return;
    }

    setSubmitError(null);
    setValues({});

    void describeForm({
      tableId,
      action,
      ...(initialRow ? { input: initialRow } : {}),
    });
  }, [action, describeForm, initialRow, opened, tableId]);

  useEffect(() => {
    const parameters = describeFormResult.data?.parameters;
    if (!parameters) {
      return;
    }

    setValues(buildInitialValues(parameters));
  }, [describeFormResult.data?.parameters]);

  const parameters = useMemo(
    () => describeFormResult.data?.parameters ?? [],
    [describeFormResult.data?.parameters],
  );

  const handleValueChange = (fieldId: string, value: unknown) => {
    setValues((currentValues) => ({
      ...currentValues,
      [fieldId]: value as EditableTableRow[string],
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (parameters.length === 0) {
      return;
    }

    try {
      setSubmitError(null);
      await onSubmit(buildRowPayload(parameters, values));
      onClose();
    } catch (error) {
      setSubmitError(getErrorMessage(error, t`Unable to save this row.`));
    }
  };

  const title = describeFormResult.data?.title ?? getModalTitle(action);
  const isLoading =
    describeFormResult.isLoading || describeFormResult.isUninitialized;

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered size="lg">
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          {isLoading ? (
            <Flex justify="center" py="xl">
              <Loader size="sm" />
            </Flex>
          ) : parameters.length === 0 ? (
            <Alert color="error" variant="light">
              {getErrorMessage(
                describeFormResult.error,
                t`No editable fields were returned for this table.`,
              )}
            </Alert>
          ) : (
            parameters.map((parameter) => (
              <ParameterInput
                key={parameter.id}
                parameter={parameter}
                value={values[parameter.id]}
                onChange={(value) => handleValueChange(parameter.id, value)}
              />
            ))
          )}

          {submitError ? (
            <Alert color="error" variant="light">
              {submitError}
            </Alert>
          ) : null}

          <Flex justify="flex-end" gap="sm">
            <Button variant="subtle" onClick={onClose}>
              {t`Cancel`}
            </Button>
            <Button
              type="submit"
              loading={isSubmitting}
              disabled={isLoading || parameters.length === 0}
            >
              {action === "create" ? t`Create row` : t`Save changes`}
            </Button>
          </Flex>
        </Stack>
      </form>
    </Modal>
  );
}

function ParameterInput({
  parameter,
  value,
  onChange,
}: {
  parameter: EditableTableFormParameter;
  value: EditableTableRow[string];
  onChange: (value: EditableTableRow[string]) => void;
}) {
  const commonProps = {
    label: parameter.display_name,
    disabled: parameter.readonly,
    withAsterisk: !parameter.optional,
  };

  if (parameter.input_type === "boolean") {
    return (
      <Switch
        {...commonProps}
        checked={Boolean(value)}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  }

  if (parameter.input_type === "integer" || parameter.input_type === "float") {
    return (
      <NumberInput
        {...commonProps}
        value={typeof value === "number" ? value : value == null ? "" : value}
        onChange={(nextValue) =>
          onChange(nextValue === "" ? null : (nextValue as number | string))
        }
        decimalScale={parameter.input_type === "integer" ? 0 : undefined}
      />
    );
  }

  if (parameter.input_type === "textarea") {
    return (
      <Textarea
        {...commonProps}
        value={value == null ? "" : String(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
        autosize
        minRows={3}
      />
    );
  }

  return (
    <TextInput
      {...commonProps}
      value={value == null ? "" : String(value)}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={getPlaceholder(parameter.input_type)}
    />
  );
}

function buildInitialValues(parameters: EditableTableFormParameter[]) {
  return Object.fromEntries(
    parameters.map((parameter) => [
      parameter.id,
      parameter.value ?? (parameter.input_type === "boolean" ? false : ""),
    ]),
  );
}

function buildRowPayload(
  parameters: EditableTableFormParameter[],
  values: EditableTableRow,
) {
  return Object.fromEntries(
    parameters.map((parameter) => {
      const value = values[parameter.id];

      if (parameter.input_type === "boolean") {
        return [parameter.id, Boolean(value)];
      }

      if (
        parameter.input_type === "integer" ||
        parameter.input_type === "float"
      ) {
        if (value == null || value === "") {
          return [parameter.id, null];
        }

        return [parameter.id, Number(value)];
      }

      if (value === "" && parameter.nullable) {
        return [parameter.id, null];
      }

      return [parameter.id, value];
    }),
  );
}

function getPlaceholder(inputType: EditableTableFormParameter["input_type"]) {
  if (inputType === "date") {
    return "YYYY-MM-DD";
  }

  if (inputType === "datetime") {
    return "YYYY-MM-DD HH:MM:SS";
  }

  return undefined;
}

function getModalTitle(action: Exclude<EditableTableAction, "delete">) {
  return action === "create" ? t`Create row` : t`Edit row`;
}
