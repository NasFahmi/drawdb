import { useEffect, useState } from "react";
import { useDiagram, useEnums, useLayout, useUndoRedo } from "../../hooks";
import { toDBML } from "../../utils/exportAs/dbml";
import { fromDBML } from "../../utils/importFrom/dbml";
import { Button, Toast, Tooltip } from "@douyinfe/semi-ui";
import { IconSaveStroked, IconTemplate } from "@douyinfe/semi-icons";
import { useTranslation } from "react-i18next";
import CodeEditor from "../CodeEditor";

export default function DBMLEditor() {
  const {
    tables: currentTables,
    relationships,
    setTables,
    setRelationships,
    database,
  } = useDiagram();
  const diagram = useDiagram();
  const { enums, setEnums } = useEnums();
  const [value, setValue] = useState(() => toDBML({ ...diagram, enums }));
  const [dirty, setDirty] = useState(false);
  const { setLayout } = useLayout();
  const { setUndoStack, setRedoStack } = useUndoRedo();
  const { t } = useTranslation();

  const toggleDBMLEditor = () => {
    setLayout((prev) => ({ ...prev, dbmlEditor: !prev.dbmlEditor }));
  };

  const applyDBML = () => {
    try {
      const parsedDiagram = fromDBML(value);

      setTables(parsedDiagram.tables);
      setRelationships(parsedDiagram.relationships);
      setEnums(parsedDiagram.enums);
      setUndoStack([]);
      setRedoStack([]);
      setDirty(false);
      setValue(toDBML({ ...parsedDiagram, database }));
      Toast.success(t("saved"));
    } catch (error) {
      const diag = error.diags?.[0];
      const message = diag
        ? `${diag.name} [Ln ${diag.location.start.line}, Col ${diag.location.start.column}]: ${diag.message}`
        : error.message;

      Toast.error(message || t("oops_smth_went_wrong"));
    }
  };

  useEffect(() => {
    if (!dirty) {
      setValue(
        toDBML({ tables: currentTables, enums, relationships, database }),
      );
    }
  }, [currentTables, dirty, enums, relationships, database]);

  return (
    <CodeEditor
      showCopyButton
      value={value}
      language="dbml"
      onChange={(newValue) => {
        setValue(newValue ?? "");
        setDirty(true);
      }}
      height="100%"
      options={{
        minimap: { enabled: false },
      }}
      extraControls={
        <>
          <Tooltip content="Apply DBML">
            <Button
              disabled={!dirty}
              icon={<IconSaveStroked />}
              onClick={applyDBML}
            />
          </Tooltip>
          <Tooltip content={t("tab_view")}>
            <Button icon={<IconTemplate />} onClick={toggleDBMLEditor} />
          </Tooltip>
        </>
      }
    />
  );
}
