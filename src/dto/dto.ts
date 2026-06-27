import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsEmail, IsPhoneNumber, IsString } from 'class-validator';

export class SendMagicLinkDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;
}

export class SendMagicLinkResponse {
  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  @Expose()
  sessionId: string;
}

export class EnrollPhoneDto {
  @ApiProperty({ example: '+12025550162' })
  @IsPhoneNumber()
  phoneNumber: string;
}

export class SubmitOtpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  code: string;
}
