import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('machines')
export class FSM {
  @PrimaryColumn({ name: 'session_id' })
  sessionId: string;

  @Column({ type: 'jsonb' })
  snapshot: object;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'processed_magic_link', default: false })
  processedMagicLink: boolean;

  @Column({ name: 'enroll_phone_number' })
  enrollPhoneNumber: string;
}
