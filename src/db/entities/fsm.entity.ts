import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import * as stytch from 'stytch';

@Entity('machines')
export class FSM {
  @PrimaryColumn({ name: 'session_id' })
  sessionId: string;

  @Column({ type: 'varchar' })
  state: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'processed_magic_link', default: false })
  processedMagicLink: boolean;

  @Column({ name: 'enroll_phone_number', type: 'varchar', nullable: true })
  enrollPhoneNumber: string | null;

  @Column({
    name: 'intermediary_session_token',
    type: 'varchar',
    nullable: true,
    default: null,
  })
  intermediarySessionToken: string | null;

  @Column({ name: 'stytch_user', type: 'jsonb', nullable: true, default: null })
  stytchUser: stytch.User | null;

  @Column({
    name: 'session_token',
    type: 'varchar',
    nullable: true,
    default: null,
  })
  sessionToken: string | null;

  @Column({ name: 'phone_id', type: 'varchar', nullable: true, default: null })
  phoneId: string | null;
}
