import { describe, expect, it } from 'vitest';
import { agodaCardPhoto } from './agoda-photo';
import { upgradeBookingPhoto } from './booking-photo';
import { originalStayPhoto } from './original-photo';

const AGODA = 'https://pix8.agoda.net/hotelImages/417108/0/c8efa945512ccad1b821cad1055e2d28.jpg?va=1&ce=3';
const BOOKING = 'https://cf.bstatic.com/xdata/images/hotel/square60/751028262.jpg?k=763506dd&o=';

describe('originalStayPhoto', () => {
	it('reverses whichever adapter wrote the address, without being told which', () => {
		expect(originalStayPhoto(agodaCardPhoto(AGODA))).toBe(AGODA);
		expect(originalStayPhoto(upgradeBookingPhoto(BOOKING))).toBe(BOOKING);
	});

	it('has nothing to offer for an address nothing rewrote', () => {
		expect(originalStayPhoto(AGODA)).toBeUndefined();
		expect(originalStayPhoto(BOOKING)).toBeUndefined();
		// Hostelworld's origin does no URL-level resizing at all, so nothing ever rewrites one.
		expect(originalStayPhoto('https://a.hwstatic.com/image/upload/propertyimages/5/527/x.jpg')).toBeUndefined();
	});
});
