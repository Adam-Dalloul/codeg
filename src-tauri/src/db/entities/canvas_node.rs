use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// What a canvas node is bound to. The three binding kinds mirror the product
/// requirement (a region shows a folder's conversations, one conversation, or
/// one agent's conversations); `custom` is a hand-curated collection and `note`
/// is a free-floating sticky. One enum — and one table — because every kind
/// shares geometry, lifecycle and the `canvas://changed` side-channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum CanvasNodeKind {
    #[sea_orm(string_value = "folder")]
    Folder,
    #[sea_orm(string_value = "agent")]
    Agent,
    #[sea_orm(string_value = "conversation")]
    Conversation,
    #[sea_orm(string_value = "custom")]
    Custom,
    #[sea_orm(string_value = "note")]
    Note,
}

/// One element on the conversation canvas. `folder_id` / `conversation_id` are
/// soft references (their targets soft-delete); kind-specific invariants —
/// which binding columns must be set, member validation — live in
/// `canvas_service`, the single write chokepoint.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "canvas_node")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub kind: CanvasNodeKind,
    pub folder_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub agent_type: Option<String>,
    pub conversation_id: Option<i32>,
    /// kind=custom only: JSON array of conversation ids, insertion order.
    #[sea_orm(column_type = "Text", nullable)]
    pub member_ids: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub title: Option<String>,
    /// kind=note only.
    #[sea_orm(column_type = "Text", nullable)]
    pub content: Option<String>,
    /// Theme-preset color name (FolderThemeColor vocabulary).
    #[sea_orm(column_type = "Text", nullable)]
    pub color: Option<String>,
    pub collapsed: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
