/**
 * ARQUIVO GERADO — não editar manualmente. Fonte de verdade: as migrations
 * em supabase/migrations/.
 *
 * PROVISÓRIO: escrito à mão porque este ambiente não tem Docker nem um
 * projeto Supabase hospedado vinculado (ver A2-HANDOFF.md). Assim que
 * `supabase link --project-ref <praxis-crm-dev>` for possível, rode
 * `npm run db:types` e este arquivo passa a ser gerado de verdade —
 * o CI já roda `supabase gen types typescript --local` contra as mesmas
 * migrations e falha se o resultado divergir do que está aqui (script
 * `db:types:check`), então qualquer erro de transcrição deste arquivo
 * aparece no primeiro PR, não seis fases depois.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      workspaces: {
        Row: {
          id: string;
          name: string;
          slug: string;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["workspaces"]["Insert"]>;
        Relationships: [];
      };
      users: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["users"]["Insert"]>;
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          role: Database["public"]["Enums"]["membership_role"];
          status: Database["public"]["Enums"]["membership_status"];
          invited_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          user_id: string;
          role: Database["public"]["Enums"]["membership_role"];
          status?: Database["public"]["Enums"]["membership_status"];
          invited_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["memberships"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "memberships_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "memberships_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_invitations: {
        Row: {
          id: string;
          workspace_id: string;
          email: string;
          role: Database["public"]["Enums"]["membership_role"];
          status: Database["public"]["Enums"]["invitation_status"];
          token_hash: string;
          invited_by: string;
          accepted_by: string | null;
          expires_at: string;
          accepted_at: string | null;
          cancelled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          email: string;
          role: Database["public"]["Enums"]["membership_role"];
          status?: Database["public"]["Enums"]["invitation_status"];
          token_hash: string;
          invited_by: string;
          accepted_by?: string | null;
          expires_at: string;
          accepted_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["workspace_invitations"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          id: string;
          workspace_id: string;
          actor_user_id: string | null;
          action: string;
          resource_type: string;
          resource_id: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          actor_user_id?: string | null;
          action: string;
          resource_type: string;
          resource_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["audit_logs"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_workspace_with_owner: {
        Args: { p_name: string; p_slug: string };
        Returns: Database["public"]["Tables"]["workspaces"]["Row"];
      };
      create_workspace_invitation: {
        Args: {
          p_workspace_id: string;
          p_email: string;
          p_role: Database["public"]["Enums"]["membership_role"];
        };
        Returns: { id: string; token: string; expires_at: string }[];
      };
      cancel_workspace_invitation: {
        Args: { p_invitation_id: string };
        Returns: undefined;
      };
      preview_workspace_invitation: {
        Args: { p_token: string };
        Returns: {
          workspace_name: string;
          role: Database["public"]["Enums"]["membership_role"];
          invited_by_name: string | null;
          email: string;
          status: Database["public"]["Enums"]["invitation_status"];
          expires_at: string;
        }[];
      };
      accept_workspace_invitation: {
        Args: { p_token: string };
        Returns: Database["public"]["Tables"]["memberships"]["Row"];
      };
      update_membership_role: {
        Args: {
          p_membership_id: string;
          p_new_role: Database["public"]["Enums"]["membership_role"];
        };
        Returns: Database["public"]["Tables"]["memberships"]["Row"];
      };
      remove_membership: {
        Args: { p_membership_id: string };
        Returns: undefined;
      };
    };
    Enums: {
      membership_role: "owner" | "admin" | "manager" | "lawyer" | "sales" | "viewer";
      membership_status: "active" | "suspended";
      invitation_status: "pending" | "accepted" | "cancelled" | "expired";
    };
    CompositeTypes: Record<string, never>;
  };
};
