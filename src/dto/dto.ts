import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class SendMagicLinkDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;
}

export class SendMagicLinkResponse {
  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  sessionId: string;
}
