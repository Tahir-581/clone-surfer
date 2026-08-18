import psycopg2

def verify_and_admin(email):
    try:
        conn = psycopg2.connect(
            host="localhost",
            port=5432,
            database="serfox_db",
            user="postgres",
            password="1234"
        )
        cur = conn.cursor()
        
        # Check if user exists
        cur.execute("SELECT id, name, email, role, email_verified FROM app_users WHERE email = %s", (email,))
        user = cur.fetchone()
        
        if not user:
            print(f"User with email {email} not found.")
            return

        print(f"Found user: {user}")
        
        # Update user
        cur.execute(
            "UPDATE app_users SET email_verified = TRUE, role = 'admin', verification_token = NULL WHERE email = %s",
            (email,)
        )
        conn.commit()
        
        print(f"User {email} has been verified and promoted to admin.")
        
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    verify_and_admin("zerolife@fexpost.com")
