export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          metadata: Json
          resource_id: string | null
          resource_type: string
          workspace_id: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          resource_id?: string | null
          resource_type: string
          workspace_id: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          resource_id?: string | null
          resource_type?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_consents: {
        Row: {
          accepted_text: string | null
          channel: Database["public"]["Enums"]["contact_channel"]
          contact_id: string
          created_at: string
          created_by: string | null
          evidence_source: string | null
          granted_at: string | null
          id: string
          legal_basis: Database["public"]["Enums"]["consent_legal_basis"]
          purpose: string
          revoked_at: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          accepted_text?: string | null
          channel: Database["public"]["Enums"]["contact_channel"]
          contact_id: string
          created_at?: string
          created_by?: string | null
          evidence_source?: string | null
          granted_at?: string | null
          id?: string
          legal_basis: Database["public"]["Enums"]["consent_legal_basis"]
          purpose: string
          revoked_at?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          accepted_text?: string | null
          channel?: Database["public"]["Enums"]["contact_channel"]
          contact_id?: string
          created_at?: string
          created_by?: string | null
          evidence_source?: string | null
          granted_at?: string | null
          id?: string
          legal_basis?: Database["public"]["Enums"]["consent_legal_basis"]
          purpose?: string
          revoked_at?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_consents_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_consents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_emails: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          source: string
          updated_at: string
          value_normalized: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          is_primary?: boolean
          source?: string
          updated_at?: string
          value_normalized: string
          verified_at?: string | null
          workspace_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          source?: string
          updated_at?: string
          value_normalized?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_emails_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_emails_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_identifiers: {
        Row: {
          contact_id: string
          created_at: string
          external_id: string
          id: string
          provider: string
          workspace_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          external_id: string
          id?: string
          provider: string
          workspace_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          external_id?: string
          id?: string
          provider?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_identifiers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_identifiers_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_merges: {
        Row: {
          candidate_id: string | null
          created_at: string
          id: string
          kept_contact_id: string
          kept_contact_previous_values: Json
          merged_at: string
          merged_by: string
          merged_contact_id: string
          moved_rows: Json
          undone_at: string | null
          undone_by: string | null
          workspace_id: string
        }
        Insert: {
          candidate_id?: string | null
          created_at?: string
          id?: string
          kept_contact_id: string
          kept_contact_previous_values?: Json
          merged_at?: string
          merged_by: string
          merged_contact_id: string
          moved_rows?: Json
          undone_at?: string | null
          undone_by?: string | null
          workspace_id: string
        }
        Update: {
          candidate_id?: string | null
          created_at?: string
          id?: string
          kept_contact_id?: string
          kept_contact_previous_values?: Json
          merged_at?: string
          merged_by?: string
          merged_contact_id?: string
          moved_rows?: Json
          undone_at?: string | null
          undone_by?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_merges_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "duplicate_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_merges_kept_contact_id_fkey"
            columns: ["kept_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_merges_merged_contact_id_fkey"
            columns: ["merged_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_merges_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_phones: {
        Row: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          source: string
          updated_at: string
          value_normalized: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          id?: string
          is_primary?: boolean
          source?: string
          updated_at?: string
          value_normalized: string
          verified_at?: string | null
          workspace_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          id?: string
          is_primary?: boolean
          source?: string
          updated_at?: string
          value_normalized?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_phones_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_phones_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_sensitive: {
        Row: {
          contact_id: string
          cpf_cnpj_blind_index: string
          cpf_cnpj_ciphertext: string
          created_at: string
          key_version: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          contact_id: string
          cpf_cnpj_blind_index: string
          cpf_cnpj_ciphertext: string
          created_at?: string
          key_version: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          contact_id?: string
          cpf_cnpj_blind_index?: string
          cpf_cnpj_ciphertext?: string
          created_at?: string
          key_version?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_sensitive_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: true
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_sensitive_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          city: string | null
          created_at: string
          created_by: string
          id: string
          merged_into_contact_id: string | null
          name: string
          preferred_channel:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          city?: string | null
          created_at?: string
          created_by: string
          id?: string
          merged_into_contact_id?: string | null
          name: string
          preferred_channel?:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          city?: string | null
          created_at?: string
          created_by?: string
          id?: string
          merged_into_contact_id?: string | null
          name?: string
          preferred_channel?:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type?: Database["public"]["Enums"]["contact_type"]
          uf?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_merged_into_contact_id_fkey"
            columns: ["merged_into_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      duplicate_candidates: {
        Row: {
          contact_a_id: string
          contact_b_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          priority: number
          signals: Json
          status: Database["public"]["Enums"]["duplicate_status"]
          tier: Database["public"]["Enums"]["duplicate_tier"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          contact_a_id: string
          contact_b_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          priority: number
          signals?: Json
          status?: Database["public"]["Enums"]["duplicate_status"]
          tier: Database["public"]["Enums"]["duplicate_tier"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          contact_a_id?: string
          contact_b_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          priority?: number
          signals?: Json
          status?: Database["public"]["Enums"]["duplicate_status"]
          tier?: Database["public"]["Enums"]["duplicate_tier"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "duplicate_candidates_contact_a_id_fkey"
            columns: ["contact_a_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_contact_b_id_fkey"
            columns: ["contact_b_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duplicate_candidates_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_values: {
        Row: {
          created_at: string
          estimated_value_cents: number | null
          lead_id: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          estimated_value_cents?: number | null
          lead_id: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          estimated_value_cents?: number | null
          lead_id?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_values_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_values_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          assigned_to: string | null
          contact_id: string
          created_at: string
          created_by: string
          id: string
          legal_area: string
          priority: Database["public"]["Enums"]["lead_priority"]
          status: Database["public"]["Enums"]["lead_status"]
          summary: string | null
          tags: string[]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          assigned_to?: string | null
          contact_id: string
          created_at?: string
          created_by: string
          id?: string
          legal_area: string
          priority?: Database["public"]["Enums"]["lead_priority"]
          status?: Database["public"]["Enums"]["lead_status"]
          summary?: string | null
          tags?: string[]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          assigned_to?: string | null
          contact_id?: string
          created_at?: string
          created_by?: string
          id?: string
          legal_area?: string
          priority?: Database["public"]["Enums"]["lead_priority"]
          status?: Database["public"]["Enums"]["lead_status"]
          summary?: string | null
          tags?: string[]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_contact_same_workspace_fkey"
            columns: ["workspace_id", "contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["workspace_id", "id"]
          },
          {
            foreignKeyName: "leads_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["membership_role"]
          status: Database["public"]["Enums"]["membership_status"]
          updated_at: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_by?: string | null
          role: Database["public"]["Enums"]["membership_role"]
          status?: Database["public"]["Enums"]["membership_status"]
          updated_at?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["membership_role"]
          status?: Database["public"]["Enums"]["membership_status"]
          updated_at?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sensitive_data_access: {
        Row: {
          actor_user_id: string | null
          contact_id: string
          created_at: string
          field: string
          id: string
          reason: string | null
          workspace_id: string
        }
        Insert: {
          actor_user_id?: string | null
          contact_id: string
          created_at?: string
          field: string
          id?: string
          reason?: string | null
          workspace_id: string
        }
        Update: {
          actor_user_id?: string | null
          contact_id?: string
          created_at?: string
          field?: string
          id?: string
          reason?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sensitive_data_access_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sensitive_data_access_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      workspace_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          cancelled_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["membership_role"]
          status: Database["public"]["Enums"]["invitation_status"]
          token_hash: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          cancelled_at?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invited_by: string
          role: Database["public"]["Enums"]["membership_role"]
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          cancelled_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["membership_role"]
          status?: Database["public"]["Enums"]["invitation_status"]
          token_hash?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_invitations_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspace_invitations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_workspace_invitation: {
        Args: { p_token: string }
        Returns: {
          created_at: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["membership_role"]
          status: Database["public"]["Enums"]["membership_status"]
          updated_at: string
          user_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "memberships"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_contact_email: {
        Args: {
          p_contact_id: string
          p_is_primary?: boolean
          p_value_normalized: string
        }
        Returns: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          source: string
          updated_at: string
          value_normalized: string
          verified_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contact_emails"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      add_contact_phone: {
        Args: {
          p_contact_id: string
          p_is_primary?: boolean
          p_value_normalized: string
        }
        Returns: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          source: string
          updated_at: string
          value_normalized: string
          verified_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contact_phones"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      assign_lead: {
        Args: {
          p_assigned_to?: string
          p_expected_updated_at?: string
          p_lead_id: string
        }
        Returns: {
          assigned_to: string | null
          contact_id: string
          created_at: string
          created_by: string
          id: string
          legal_area: string
          priority: Database["public"]["Enums"]["lead_priority"]
          status: Database["public"]["Enums"]["lead_status"]
          summary: string | null
          tags: string[]
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      cancel_workspace_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      clear_contact_cpf_cnpj: {
        Args: { p_contact_id: string }
        Returns: undefined
      }
      contact_has_sensitive: {
        Args: { p_contact_id: string }
        Returns: boolean
      }
      create_contact: {
        Args: {
          p_city?: string
          p_cpf_blind_index_base64?: string
          p_cpf_ciphertext_base64?: string
          p_cpf_key_version?: string
          p_emails?: Json
          p_name: string
          p_phones?: Json
          p_preferred_channel?: Database["public"]["Enums"]["contact_channel"]
          p_type: Database["public"]["Enums"]["contact_type"]
          p_uf?: string
          p_workspace_id: string
        }
        Returns: {
          city: string | null
          created_at: string
          created_by: string
          id: string
          merged_into_contact_id: string | null
          name: string
          preferred_channel:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf: string | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_lead: {
        Args: {
          p_assigned_to?: string
          p_contact_id: string
          p_estimated_value_cents?: number
          p_legal_area: string
          p_priority?: Database["public"]["Enums"]["lead_priority"]
          p_summary?: string
          p_tags?: string[]
          p_workspace_id: string
        }
        Returns: string
      }
      create_workspace_invitation: {
        Args: {
          p_email: string
          p_role: Database["public"]["Enums"]["membership_role"]
          p_workspace_id: string
        }
        Returns: {
          expires_at: string
          id: string
          token: string
        }[]
      }
      create_workspace_with_owner: {
        Args: { p_name: string; p_slug: string }
        Returns: {
          created_at: string
          created_by: string
          id: string
          name: string
          slug: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "workspaces"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      dismiss_duplicate_candidate: {
        Args: { p_candidate_id: string }
        Returns: undefined
      }
      get_contact_merge_history: {
        Args: { p_contact_id: string }
        Returns: {
          merge_id: string
          merged_at: string
          merged_contact_id: string
          merged_contact_name: string
          undone_at: string
        }[]
      }
      get_lead: { Args: { p_lead_id: string }; Returns: Json }
      list_leads: {
        Args: {
          p_assigned_to?: string
          p_legal_area?: string
          p_page?: number
          p_page_size?: number
          p_priority?: Database["public"]["Enums"]["lead_priority"]
          p_search?: string
          p_sort?: string
          p_status?: Database["public"]["Enums"]["lead_status"]
          p_workspace_id: string
        }
        Returns: {
          items: Json
          total_count: number
        }[]
      }
      merge_contacts: {
        Args: {
          p_candidate_id?: string
          p_field_resolutions?: Json
          p_kept_contact_id: string
          p_merged_contact_id: string
        }
        Returns: {
          city: string | null
          created_at: string
          created_by: string
          id: string
          merged_into_contact_id: string | null
          name: string
          preferred_channel:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf: string | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      preview_workspace_invitation: {
        Args: { p_token: string }
        Returns: {
          email: string
          expires_at: string
          invited_by_name: string
          role: Database["public"]["Enums"]["membership_role"]
          status: Database["public"]["Enums"]["invitation_status"]
          workspace_name: string
        }[]
      }
      remove_contact_email: { Args: { p_email_id: string }; Returns: undefined }
      remove_contact_phone: { Args: { p_phone_id: string }; Returns: undefined }
      remove_membership: {
        Args: { p_membership_id: string }
        Returns: undefined
      }
      reveal_contact_cpf_cnpj: {
        Args: { p_contact_id: string; p_reason?: string }
        Returns: {
          ciphertext_base64: string
          key_version: string
        }[]
      }
      search_contacts_by_cpf_cnpj: {
        Args: { p_blind_indexes_base64: string[]; p_workspace_id: string }
        Returns: {
          city: string | null
          created_at: string
          created_by: string
          id: string
          merged_into_contact_id: string | null
          name: string
          preferred_channel:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf: string | null
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      set_contact_cpf_cnpj: {
        Args: {
          p_blind_index_base64: string
          p_ciphertext_base64: string
          p_contact_id: string
          p_key_version: string
        }
        Returns: undefined
      }
      set_lead_status: {
        Args: {
          p_expected_updated_at?: string
          p_lead_id: string
          p_status: Database["public"]["Enums"]["lead_status"]
        }
        Returns: {
          assigned_to: string | null
          contact_id: string
          created_at: string
          created_by: string
          id: string
          legal_area: string
          priority: Database["public"]["Enums"]["lead_priority"]
          status: Database["public"]["Enums"]["lead_status"]
          summary: string | null
          tags: string[]
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_lead_value: {
        Args: {
          p_estimated_value_cents?: number
          p_expected_updated_at?: string
          p_lead_id: string
        }
        Returns: undefined
      }
      unmerge_contact: {
        Args: { p_merge_id: string }
        Returns: {
          city: string | null
          created_at: string
          created_by: string
          id: string
          merged_into_contact_id: string | null
          name: string
          preferred_channel:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf: string | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_contact_basic_fields: {
        Args: {
          p_city?: string
          p_contact_id: string
          p_name: string
          p_preferred_channel?: Database["public"]["Enums"]["contact_channel"]
          p_uf?: string
        }
        Returns: {
          city: string | null
          created_at: string
          created_by: string
          id: string
          merged_into_contact_id: string | null
          name: string
          preferred_channel:
            | Database["public"]["Enums"]["contact_channel"]
            | null
          type: Database["public"]["Enums"]["contact_type"]
          uf: string | null
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_contact_email: {
        Args: {
          p_email_id: string
          p_is_primary?: boolean
          p_value_normalized: string
        }
        Returns: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          source: string
          updated_at: string
          value_normalized: string
          verified_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contact_emails"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_contact_phone: {
        Args: {
          p_is_primary?: boolean
          p_phone_id: string
          p_value_normalized: string
        }
        Returns: {
          contact_id: string
          created_at: string
          id: string
          is_primary: boolean
          source: string
          updated_at: string
          value_normalized: string
          verified_at: string | null
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "contact_phones"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_lead_basic_fields: {
        Args: {
          p_expected_updated_at?: string
          p_lead_id: string
          p_legal_area: string
          p_priority?: Database["public"]["Enums"]["lead_priority"]
          p_summary?: string
          p_tags?: string[]
        }
        Returns: {
          assigned_to: string | null
          contact_id: string
          created_at: string
          created_by: string
          id: string
          legal_area: string
          priority: Database["public"]["Enums"]["lead_priority"]
          status: Database["public"]["Enums"]["lead_status"]
          summary: string | null
          tags: string[]
          updated_at: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_membership_role: {
        Args: {
          p_membership_id: string
          p_new_role: Database["public"]["Enums"]["membership_role"]
        }
        Returns: {
          created_at: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["membership_role"]
          status: Database["public"]["Enums"]["membership_status"]
          updated_at: string
          user_id: string
          workspace_id: string
        }
        SetofOptions: {
          from: "*"
          to: "memberships"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      consent_legal_basis:
        | "consentimento"
        | "legitimo_interesse"
        | "execucao_de_contrato"
        | "obrigacao_legal"
        | "outro"
      contact_channel: "whatsapp" | "email" | "telefone" | "presencial"
      contact_type: "pf" | "pj"
      duplicate_status: "pending" | "merged" | "dismissed"
      duplicate_tier: "strong" | "review" | "low"
      invitation_status: "pending" | "accepted" | "cancelled" | "expired"
      lead_priority: "baixa" | "media" | "alta"
      lead_status: "ativo" | "arquivado"
      membership_role:
        | "owner"
        | "admin"
        | "manager"
        | "lawyer"
        | "sales"
        | "viewer"
      membership_status: "active" | "suspended"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      consent_legal_basis: [
        "consentimento",
        "legitimo_interesse",
        "execucao_de_contrato",
        "obrigacao_legal",
        "outro",
      ],
      contact_channel: ["whatsapp", "email", "telefone", "presencial"],
      contact_type: ["pf", "pj"],
      duplicate_status: ["pending", "merged", "dismissed"],
      duplicate_tier: ["strong", "review", "low"],
      invitation_status: ["pending", "accepted", "cancelled", "expired"],
      lead_priority: ["baixa", "media", "alta"],
      lead_status: ["ativo", "arquivado"],
      membership_role: [
        "owner",
        "admin",
        "manager",
        "lawyer",
        "sales",
        "viewer",
      ],
      membership_status: ["active", "suspended"],
    },
  },
} as const

