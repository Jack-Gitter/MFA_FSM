import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('machines')
export class FSM {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'jsonb' })
  snapshot: object;

  @Column({ type: 'jsonb', name: 'last_transition' })
  lastTransition: { prev: string; current: string };

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
