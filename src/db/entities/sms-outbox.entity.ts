import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OutboxStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

@Entity('sms_otp_outbox')
export class SMSOTPOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'phone_number' })
  phoneNumber: string;

  @Column({ name: 'session_id' })
  sessionId: string;

  @Column({ name: 'session_token' })
  sessionToken: string;

  @Column({ type: 'enum', enum: OutboxStatus, default: OutboxStatus.PENDING })
  status: OutboxStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
