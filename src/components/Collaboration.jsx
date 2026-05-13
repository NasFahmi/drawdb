import { Tag } from "@douyinfe/semi-ui";
import { IconUserGroup } from "@douyinfe/semi-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { databases } from "../data/databases";
import { State } from "../data/constants";
import {
  useAreas,
  useCanvas,
  useDiagram,
  useEnums,
  useNotes,
  useSaveState,
  useSelect,
  useTypes,
  useUndoRedo,
} from "../hooks";
import { useTranslation } from "react-i18next";
import { createId } from "../utils/id";

const SCALAR_KEYS = ["title", "database"];
const COLLECTIONS = [
  { stateKey: "tables", mapKey: "tablesById", orderKey: "tableOrder" },
  {
    stateKey: "relationships",
    mapKey: "relationshipsById",
    orderKey: "relationshipOrder",
  },
  { stateKey: "notes", mapKey: "notesById", orderKey: "noteOrder" },
  { stateKey: "subjectAreas", mapKey: "areasById", orderKey: "areaOrder" },
  { stateKey: "types", mapKey: "typesById", orderKey: "typeOrder" },
  { stateKey: "enums", mapKey: "enumsById", orderKey: "enumOrder" },
];

function getCollaborationUrl() {
  if (import.meta.env.VITE_COLLABORATION_URL) {
    return import.meta.env.VITE_COLLABORATION_URL.replace(/\/$/, "");
  }

  if (window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:5174`;
  }

  return window.location.origin;
}

function getCollaborationSocketUrl() {
  const url = new URL(getCollaborationUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

function getClientId() {
  return createId();
}

function getClientColor(clientId) {
  const colors = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c"];
  const index = [...clientId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return colors[index % colors.length];
}

function getSharedState(sharedDiagram) {
  const database = sharedDiagram.get("database");
  if (!database) return null;

  const state = {
    title: sharedDiagram.get("title") || "Untitled Diagram",
    database,
  };

  for (const collection of COLLECTIONS) {
    const byId = sharedDiagram.get(collection.mapKey);
    const order = sharedDiagram.get(collection.orderKey);

    if (byId instanceof Y.Map && order instanceof Y.Array) {
      state[collection.stateKey] = order
        .toArray()
        .map((id) => byId.get(id))
        .filter(Boolean);
    } else {
      state[collection.stateKey] = sharedDiagram.get(collection.stateKey) || [];
    }
  }

  return state;
}

function getOrCreateYMap(parent, key) {
  const existing = parent.get(key);
  if (existing instanceof Y.Map) return existing;

  const map = new Y.Map();
  parent.set(key, map);
  return map;
}

function getOrCreateYArray(parent, key) {
  const existing = parent.get(key);
  if (existing instanceof Y.Array) return existing;

  const array = new Y.Array();
  parent.set(key, array);
  return array;
}

function areEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function syncCollection(sharedDiagram, collection, items = [], previousItems) {
  const byId = getOrCreateYMap(sharedDiagram, collection.mapKey);
  const order = getOrCreateYArray(sharedDiagram, collection.orderKey);
  const nextIds = items.map((item) => String(item.id));
  const nextIdSet = new Set(nextIds);
  const previousById = new Map(
    (previousItems || []).map((item) => [String(item.id), item]),
  );
  const previousIds = (previousItems || []).map((item) => String(item.id));

  for (const id of previousById.keys()) {
    if (!nextIdSet.has(id) && byId.has(id)) {
      byId.delete(id);
    }
  }

  for (const item of items) {
    const id = String(item.id);
    if (!areEqual(item, previousById.get(id))) {
      byId.set(id, item);
    }
  }

  if (!areEqual(nextIds, previousIds)) {
    if (order.length > 0) {
      order.delete(0, order.length);
    }
    if (nextIds.length > 0) {
      order.insert(0, nextIds);
    }
  }
}

export default function Collaboration({ title, setTitle }) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const roomId = searchParams.get("collab");
  const clientId = useMemo(getClientId, []);
  const collaborationUrl = useMemo(getCollaborationSocketUrl, []);
  const [peers, setPeers] = useState(1);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState({});
  const ydocRef = useRef(null);
  const providerRef = useRef(null);
  const sharedDiagramRef = useRef(null);
  const localOriginRef = useRef({});
  const buildStateRef = useRef(() => null);
  const previousSharedStateRef = useRef(null);
  const lastLocalJsonRef = useRef("");
  const applyingRemoteRef = useRef(false);
  const lastCursorSentAtRef = useRef(0);
  const { coords, pointer } = useCanvas();
  const { setSaveState } = useSaveState();
  const { selectedElement, bulkSelectedElements, setRemoteSelections } = useSelect();
  const {
    tables,
    relationships,
    database,
    setTables,
    setRelationships,
    setDatabase,
  } = useDiagram();
  const { notes, setNotes } = useNotes();
  const { areas, setAreas } = useAreas();
  const { types, setTypes } = useTypes();
  const { enums, setEnums } = useEnums();
  const { setUndoStack, setRedoStack } = useUndoRedo();

  const buildState = useCallback(
    () => ({
      title,
      database,
      tables,
      relationships,
      notes,
      subjectAreas: areas,
      ...(databases[database]?.hasTypes && { types }),
      ...(databases[database]?.hasEnums && { enums }),
    }),
    [
      areas,
      database,
      enums,
      notes,
      relationships,
      tables,
      title,
      types,
    ],
  );

  useEffect(() => {
    buildStateRef.current = buildState;
  }, [buildState]);

  const applyState = useCallback(
    (state) => {
      if (!state) return;

      applyingRemoteRef.current = true;
      const stateJson = JSON.stringify(state);
      lastLocalJsonRef.current = stateJson;
      previousSharedStateRef.current = state;

      setDatabase(state.database);
      setTitle(state.title || "Untitled Diagram");
      setTables(state.tables || []);
      setRelationships(state.relationships || []);
      setNotes(state.notes || []);
      setAreas(state.subjectAreas || []);
      setTypes(state.types || []);
      setEnums(state.enums || []);
      setUndoStack([]);
      setRedoStack([]);
      setSaveState(State.SAVED);

      window.setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 80);
    },
    [
      setAreas,
      setDatabase,
      setEnums,
      setNotes,
      setRedoStack,
      setRelationships,
      setSaveState,
      setTables,
      setTitle,
      setTypes,
      setUndoStack,
    ],
  );

  const writeSharedState = useCallback((state, previousState = null) => {
    const ydoc = ydocRef.current;
    const sharedDiagram = sharedDiagramRef.current;
    if (!ydoc || !sharedDiagram) return;

    ydoc.transact(() => {
      for (const key of SCALAR_KEYS) {
        if (!previousState || !areEqual(state[key], previousState[key])) {
          sharedDiagram.set(key, state[key]);
        }
      }

      for (const collection of COLLECTIONS) {
        syncCollection(
          sharedDiagram,
          collection,
          state[collection.stateKey],
          previousState?.[collection.stateKey],
        );
        sharedDiagram.delete(collection.stateKey);
      }
    }, localOriginRef.current);
  }, []);

  useEffect(() => {
    if (!roomId) return;

    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(
      collaborationUrl,
      `drawdb-${roomId}`,
      ydoc,
      {
        params: { clientId },
        maxBackoffTime: 1500,
      },
    );
    const sharedDiagram = ydoc.getMap("diagram");

    ydocRef.current = ydoc;
    providerRef.current = provider;
    sharedDiagramRef.current = sharedDiagram;

    provider.awareness.setLocalStateField("user", {
      clientId,
      label: `User ${clientId.slice(0, 4)}`,
      color: getClientColor(clientId),
    });

    const handleStatus = ({ status }) => {
      setConnected(status === "connected");
    };

    const handleSync = (isSynced) => {
      setSynced(isSynced);
      if (!isSynced) return;

      const sharedState = getSharedState(sharedDiagram);
      if (sharedState) {
        applyState(sharedState);
      } else {
        const state = buildStateRef.current();
        lastLocalJsonRef.current = JSON.stringify(state);
        previousSharedStateRef.current = state;
        writeSharedState(state);
      }
    };

    const handleSharedChange = (...args) => {
      const transaction = args[1];
      if (transaction.origin === localOriginRef.current) return;
      applyState(getSharedState(sharedDiagram));
    };

    const handleAwarenessChange = () => {
      const states = [...provider.awareness.getStates().values()];
      setPeers(states.length || 1);

      const selections = [];
      const cursors = {};

      states.forEach((state) => {
        if (!state?.user || state.user.clientId === clientId) return;

        if (state.selection) {
          selections.push({
            user: state.user,
            selection: state.selection,
          });
        }

        if (state.cursor) {
          cursors[state.user.clientId] = {
            ...state.cursor,
            color: state.user.color,
            label: state.user.label,
            updatedAt: Date.now(),
          };
        }
      });

      setRemoteCursors(cursors);
      setRemoteSelections(selections);
    };

    provider.on("status", handleStatus);
    provider.on("sync", handleSync);
    sharedDiagram.observeDeep(handleSharedChange);
    provider.awareness.on("change", handleAwarenessChange);

    return () => {
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      sharedDiagram.unobserveDeep(handleSharedChange);
      provider.awareness.off("change", handleAwarenessChange);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      providerRef.current = null;
      sharedDiagramRef.current = null;
    };
  }, [
    applyState,
    clientId,
    collaborationUrl,
    roomId,
    setRemoteSelections,
    writeSharedState,
  ]);

  useEffect(() => {
    if (!roomId || !connected || !synced || applyingRemoteRef.current) return;

    const state = buildState();
    const json = JSON.stringify(state);
    if (json === lastLocalJsonRef.current) return;

    lastLocalJsonRef.current = json;
    writeSharedState(state, previousSharedStateRef.current);
    previousSharedStateRef.current = state;
  }, [buildState, connected, roomId, synced, writeSharedState]);

  useEffect(() => {
    if (!roomId || !providerRef.current) return;

    const now = Date.now();
    if (now - lastCursorSentAtRef.current < 40) return;
    lastCursorSentAtRef.current = now;

    providerRef.current.awareness.setLocalStateField(
      "cursor",
      pointer.spaces.diagram,
    );
  }, [pointer.spaces.diagram, roomId]);

  useEffect(() => {
    if (!roomId || !providerRef.current) return;

    providerRef.current.awareness.setLocalStateField("selection", {
      selectedElement,
      bulkSelectedElements,
    });
  }, [selectedElement, bulkSelectedElements, roomId]);

  if (!roomId) return null;

  return (
    <>
      <div className="absolute right-8 top-2 z-10 pointer-events-none">
        <Tag
          color={connected ? "green" : "orange"}
          prefixIcon={<IconUserGroup />}
          size="large"
        >
          {connected
            ? t("collaboration_connected", { count: peers })
            : t("collaboration_connecting")}
        </Tag>
      </div>
      <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
        {Object.entries(remoteCursors).map(([id, cursor]) => {
          if (Date.now() - cursor.updatedAt > 8000) return null;

          const screen = coords.toScreenSpace(cursor);
          if (
            typeof screen.x !== "number" ||
            typeof screen.y !== "number" ||
            Number.isNaN(screen.x) ||
            Number.isNaN(screen.y)
          ) {
            return null;
          }

          return (
            <div
              key={id}
              className="absolute flex items-start gap-1"
              style={{
                transform: `translate(${screen.x}px, ${screen.y}px)`,
              }}
            >
              <div
                style={{
                  width: 0,
                  height: 0,
                  borderTop: "12px solid transparent",
                  borderBottom: "12px solid transparent",
                  borderLeft: `18px solid ${cursor.color}`,
                  transform: "rotate(-35deg)",
                }}
              />
              <div
                className="rounded px-1.5 py-0.5 text-xs text-white shadow"
                style={{ backgroundColor: cursor.color }}
              >
                {cursor.label}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
